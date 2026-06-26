#!/usr/bin/env python3
"""Extract a small selection of reads from a (possibly huge, possibly gzipped)
FASTQ/FASTA file for display.

Design constraints (see spec): the input can be tens of GB, so this tool must
never load the whole file into memory, must read only as much as the selection
requires, and must never emit the whole file. Each mode below stops as early as
it can; unbounded searches are bounded by --scan-cap; output is capped by
--max-reads / --max-seq-len / --max-payload-bytes.

Selection is passed as a JSON params file (avoids arg-quoting issues with
headers/patterns). Output is reads.json.
"""

import argparse
import gzip
import json
import os
import random
import sys


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Streaming record readers (text mode). Each yields (header, sequence, quality);
# quality is None for FASTA. Headers exclude the leading '@' / '>'.
# ---------------------------------------------------------------------------

def iter_fastq(fh):
    while True:
        h = fh.readline()
        if not h:
            return
        seq = fh.readline()
        plus = fh.readline()
        qual = fh.readline()
        if not qual:
            return  # truncated trailing record
        # Validate the 4-line framing rather than trusting it. Without this, a
        # desynced or mis-detected (e.g. FASTA-as-FASTQ) stream would silently
        # pair the wrong header/sequence/quality. Stop instead of emitting garbage.
        if not h.startswith("@") or not plus.startswith("+"):
            return
        yield (h[1:].rstrip("\n\r"), seq.rstrip("\n\r"), qual.rstrip("\n\r"))


def iter_fasta(fh):
    header = None
    parts = []
    for line in fh:
        line = line.rstrip("\n\r")
        if line.startswith(">"):
            if header is not None:
                yield (header, "".join(parts), None)
            header = line[1:]
            parts = []
        elif header is not None:
            parts.append(line)
    if header is not None:
        yield (header, "".join(parts), None)


def open_text(path, gzipped):
    if gzipped:
        return gzip.open(path, "rt")
    return open(path, "rt")


def records(path, fmt, gzipped):
    fh = open_text(path, gzipped)
    try:
        it = iter_fastq(fh) if fmt == "fastq" else iter_fasta(fh)
        for rec in it:
            yield rec
    finally:
        fh.close()


# ---------------------------------------------------------------------------
# Bounded emitter — enforces the output caps so we never emit a whole file.
# ---------------------------------------------------------------------------

class Emitter:
    def __init__(self, max_reads, max_seq_len, max_payload_bytes):
        self.max_reads = max_reads
        self.max_seq_len = max_seq_len
        self.max_payload_bytes = max_payload_bytes
        self.reads = []
        self.payload = 0
        self.truncated = False  # hit a cap, more would have been emitted

    def full(self):
        return len(self.reads) >= self.max_reads or self.payload >= self.max_payload_bytes

    def add(self, number, header, seq, qual):
        if self.full():
            self.truncated = True
            return False
        seq_len = len(seq)
        seq_trunc = seq_len > self.max_seq_len
        out_seq = seq[: self.max_seq_len]
        rec = {"number": number, "header": header, "sequence": out_seq, "seqLen": seq_len}
        if seq_trunc:
            rec["seqTruncated"] = True
        if qual is not None:
            rec["quality"] = qual[: self.max_seq_len]
        self.payload += len(out_seq) + (len(rec.get("quality", ""))) + len(header) + 32
        self.reads.append(rec)
        return True


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

def mode_range_sequential(path, fmt, gzipped, start, count, em):
    n = 0
    for header, seq, qual in records(path, fmt, gzipped):
        n += 1
        if n < start:
            continue
        if not em.add(n, header, seq, qual):
            break
        if len(em.reads) >= count:
            break


def mode_numbers(path, fmt, gzipped, numbers, scan_cap, em):
    if not numbers:
        return {"scannedToCap": False}
    wanted = set(numbers)
    max_n = max(wanted)
    scanned_to_cap = False
    for n, (header, seq, qual) in enumerate(records(path, fmt, gzipped), 1):
        # A huge requested ordinal must not force a full-file scan.
        if n > scan_cap:
            scanned_to_cap = True
            break
        if n in wanted:
            em.add(n, header, seq, qual)
            wanted.discard(n)
        if not wanted or n >= max_n or em.full():
            break
    return {"scannedToCap": scanned_to_cap}


def _header_matches(header, target):
    # exact full header, or exact match on the read id (first whitespace token).
    # Deliberately NOT a prefix match: "read1" must not match "read10".
    return header == target or header.split()[0:1] == [target]


def mode_headers(path, fmt, gzipped, headers, scan_cap, em):
    wanted = list(dict.fromkeys(headers))  # dedup, preserve order
    if not wanted:
        return {"scannedToCap": False, "notFoundHeaders": []}
    remaining = set(wanted)
    scanned_to_cap = False
    for n, (header, seq, qual) in enumerate(records(path, fmt, gzipped), 1):
        if n > scan_cap:
            scanned_to_cap = True
            break
        hit = None
        for target in remaining:
            if _header_matches(header, target):
                hit = target
                break
        if hit is not None:
            em.add(n, header, seq, qual)
            remaining.discard(hit)
        if not remaining or em.full():
            break
    return {"scannedToCap": scanned_to_cap, "notFoundHeaders": sorted(remaining)}


def mode_pattern(path, fmt, gzipped, pattern, count, scan_cap, em):
    pat = pattern.upper()
    scanned_to_cap = False
    for n, (header, seq, qual) in enumerate(records(path, fmt, gzipped), 1):
        if n > scan_cap:
            scanned_to_cap = True
            break
        if pat in seq.upper():
            em.add(n, header, seq, qual)
            if len(em.reads) >= count or em.full():
                break
    return {"scannedToCap": scanned_to_cap}


def mode_range_random_gzip(path, fmt, gzipped, count, seed, scan_cap, em):
    """gzip has no random access — single bounded reservoir-sampling pass."""
    rng = random.Random(seed)
    reservoir = []  # (number, header, seq, qual)
    n_seen = 0
    approximate = False
    for n, rec in enumerate(records(path, fmt, gzipped), 1):
        if n > scan_cap:
            approximate = True
            break
        n_seen += 1
        if len(reservoir) < count:
            reservoir.append((n,) + rec)
        else:
            j = rng.randint(0, n_seen - 1)
            if j < count:
                reservoir[j] = (n,) + rec
    reservoir.sort(key=lambda r: r[0])
    for number, header, seq, qual in reservoir:
        if not em.add(number, header, seq, qual):
            break
    return {"approximate": approximate}


def _resync_fastq(fb):
    """From the current position, find the next plausible FASTQ record.
    Returns (header, seq, qual) or None. Disambiguates '@' quality chars by
    requiring a '+' separator and len(seq)==len(qual)."""
    fb.readline()  # drop partial line
    for _ in range(2000):  # bounded resync window
        line = fb.readline()
        if not line:
            return None
        if line[:1] == b"@":
            seq = fb.readline()
            plus = fb.readline()
            qual = fb.readline()
            if not qual:
                return None
            if plus[:1] == b"+" and len(seq) == len(qual):
                return (
                    line[1:].rstrip(b"\n\r").decode("utf-8", "replace"),
                    seq.rstrip(b"\n\r").decode("utf-8", "replace"),
                    qual.rstrip(b"\n\r").decode("utf-8", "replace"),
                )
    return None


def _resync_fasta(fb):
    fb.readline()  # drop partial line
    header = None
    for _ in range(100000):
        line = fb.readline()
        if not line:
            break
        if line[:1] == b">":
            header = line[1:].rstrip(b"\n\r").decode("utf-8", "replace")
            break
    if header is None:
        return None
    parts = []
    for _ in range(100000):
        pos = fb.tell()
        line = fb.readline()
        if not line or line[:1] == b">":
            fb.seek(pos)
            break
        parts.append(line.rstrip(b"\n\r").decode("utf-8", "replace"))
    return (header, "".join(parts), None)


def mode_range_random_seek(path, fmt, count, seed, em):
    """Uncompressed random access: seek to random byte offsets and read one
    record near each. Reads ~count records regardless of file size."""
    size = os.path.getsize(path)
    rng = random.Random(seed)
    seen_headers = set()
    collected = []  # (offset-order, header, seq, qual) — we number by appearance
    attempts = 0
    max_attempts = count * 12 + 50
    with open(path, "rb") as fb:
        while len(collected) < count and attempts < max_attempts:
            attempts += 1
            off = rng.randint(0, max(0, size - 1))
            fb.seek(off)
            rec = _resync_fastq(fb) if fmt == "fastq" else _resync_fasta(fb)
            if rec is None:
                continue
            if rec[0] in seen_headers:
                continue
            seen_headers.add(rec[0])
            collected.append((off, rec))
    collected.sort(key=lambda x: x[0])
    # number is unknown (we didn't count); use sequential display index
    for i, (_, (header, seq, qual)) in enumerate(collected, 1):
        if not em.add(i, header, seq, qual):
            break
    return {"randomByOffset": True, "numbersAreOrdinal": False}


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--params", required=True)
    ap.add_argument("--output", required=True)
    a = ap.parse_args()

    with open(a.params) as f:
        p = json.load(f)

    fmt = p.get("format", "fastq")
    gzipped = bool(p.get("gzipped", a.input.endswith(".gz")))
    mode = p.get("mode", "range")
    seed = int(p.get("seed", 42))
    scan_cap = int(p.get("scanCap", 2_000_000))

    em = Emitter(
        max_reads=int(p.get("maxReads", 1000)),
        max_seq_len=int(p.get("maxSeqLen", 2000)),
        max_payload_bytes=int(p.get("maxPayloadBytes", 8_000_000)),
    )

    meta = {}
    if mode == "range":
        count = int(p.get("count", 100))
        if p.get("randomize"):
            if gzipped:
                meta = mode_range_random_gzip(a.input, fmt, gzipped, count, seed, scan_cap, em)
            else:
                meta = mode_range_random_seek(a.input, fmt, count, seed, em)
        else:
            start = max(1, int(p.get("start", 1)))
            mode_range_sequential(a.input, fmt, gzipped, start, count, em)
    elif mode == "numbers":
        nums = [int(x) for x in p.get("numbers", [])]
        meta = mode_numbers(a.input, fmt, gzipped, nums, scan_cap, em)
    elif mode == "headers":
        meta = mode_headers(a.input, fmt, gzipped, p.get("headers", []), scan_cap, em)
    elif mode == "pattern":
        count = int(p.get("count", 100))
        meta = mode_pattern(a.input, fmt, gzipped, p.get("pattern", ""), count, scan_cap, em)
    else:
        raise SystemExit("unknown mode: " + mode)

    result = {
        "reads": em.reads,
        "total": len(em.reads),
        "truncated": em.truncated,
    }
    result.update(meta)

    with open(a.output, "w") as f:
        json.dump(result, f)
    log("extracted %d reads (mode=%s, truncated=%s)" % (len(em.reads), mode, em.truncated))


if __name__ == "__main__":
    main()
