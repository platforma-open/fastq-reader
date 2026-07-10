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
    # Emits FULL reads (no per-read sequence truncation) so the UI can both render
    # and offer a faithful FASTQ/FASTA download. Display-side truncation of very
    # long reads is handled in the UI. Volume is bounded by max_reads and
    # max_payload_bytes (kept under the ~4 MB inline-JSON limit).
    def __init__(self, max_reads, max_payload_bytes):
        self.max_reads = max_reads
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
        rec = {"number": number, "header": header, "sequence": seq, "seqLen": len(seq)}
        if qual is not None:
            rec["quality"] = qual
        self.payload += len(seq) + len(qual or "") + len(header) + 32
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


def mode_range_random(path, fmt, gzipped, count, seed, scan_cap, em):
    """Single bounded reservoir-sampling pass, used for BOTH gzipped and
    uncompressed input.

    Pairing guarantee: R1 and R2 are extracted by separate invocations, but with
    the same seed and — for mates — the same read count and order. Reservoir
    sampling is fully determined by (seed, number of records seen), so both sides
    make identical selection decisions and pick the SAME read ordinals. Emitting
    by ordinal therefore keeps R1[i]/R2[i] aligned as mates. (Byte-offset seeking
    was faster on uncompressed input but could not preserve this alignment.)"""
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
        max_payload_bytes=int(p.get("maxPayloadBytes", 3_000_000)),
    )

    meta = {}
    if mode == "range":
        count = int(p.get("count", 100))
        if p.get("randomize"):
            # Reservoir sampling for both gzip and uncompressed — keeps paired
            # R1/R2 aligned (same seed + equal read counts ⇒ same ordinals).
            meta = mode_range_random(a.input, fmt, gzipped, count, seed, scan_cap, em)
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
