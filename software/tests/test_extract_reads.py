#!/usr/bin/env python3
"""Tests for extract_reads.py.

Exercises the real CLI contract (params.json -> reads.json) that the workflow
uses, across modes, formats, gzip, and edge cases. Stdlib only:

    python3 -m unittest test_extract_reads -v
"""

import gzip
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "src_python", "extract_reads.py")


def write_fastq(path, n, gzipped=False, seq_for=None):
    seq_for = seq_for or (lambda i: "ACGT" * 5 + ("AAAA" if i % 3 == 0 else "TTTT"))
    lines = []
    for i in range(1, n + 1):
        s = seq_for(i)
        lines.append("@read%d desc%d\n%s\n+\n%s\n" % (i, i, s, "I" * len(s)))
    text = "".join(lines)
    opener = gzip.open if gzipped else open
    with opener(path, "wt") as f:
        f.write(text)


def write_fasta(path, n, seq_for=None):
    seq_for = seq_for or (lambda i: "ACGTACGTAC" * 3)
    with open(path, "wt") as f:
        for i in range(1, n + 1):
            # multi-line sequence to exercise the fasta reader
            s = seq_for(i)
            f.write(">seq%d info%d\n" % (i, i))
            for j in range(0, len(s), 10):
                f.write(s[j : j + 10] + "\n")


def run(input_path, params, output_path):
    pj = output_path + ".params.json"
    with open(pj, "w") as f:
        json.dump(params, f)
    subprocess.run(
        [sys.executable, TOOL, "--input", input_path, "--params", pj, "--output", output_path],
        check=True,
        capture_output=True,
    )
    with open(output_path) as f:
        return json.load(f)


class ExtractReadsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _p(self, name):
        return os.path.join(self.tmp, name)

    def _out(self):
        return self._p("reads.json")

    # ---- range sequential ----

    def test_range_sequential(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 20)
        d = run(fq, {"format": "fastq", "mode": "range", "start": 3, "count": 4}, self._out())
        self.assertEqual([r["number"] for r in d["reads"]], [3, 4, 5, 6])
        self.assertFalse(d["truncated"])

    def test_range_count_exceeds_file(self):
        # Asking for more reads than exist returns all available, no error.
        fq = self._p("t.fastq")
        write_fastq(fq, 5)
        d = run(fq, {"format": "fastq", "mode": "range", "start": 1, "count": 100}, self._out())
        self.assertEqual(d["total"], 5)
        self.assertFalse(d["truncated"])

    def test_range_start_beyond_eof(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 5)
        d = run(fq, {"format": "fastq", "mode": "range", "start": 99, "count": 10}, self._out())
        self.assertEqual(d["total"], 0)
        self.assertEqual(d["reads"], [])

    # ---- numbers ----

    def test_numbers(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 20)
        d = run(fq, {"format": "fastq", "mode": "numbers", "numbers": [2, 5, 9]}, self._out())
        self.assertEqual([r["number"] for r in d["reads"]], [2, 5, 9])

    def test_number_bigger_than_file(self):
        # The headline edge case: a requested ordinal past EOF is simply absent;
        # existing ones still return, no crash.
        fq = self._p("t.fastq")
        write_fastq(fq, 5)
        d = run(fq, {"format": "fastq", "mode": "numbers", "numbers": [2, 999]}, self._out())
        self.assertEqual([r["number"] for r in d["reads"]], [2])
        self.assertEqual(d["total"], 1)

    def test_numbers_all_beyond_eof(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 3)
        d = run(fq, {"format": "fastq", "mode": "numbers", "numbers": [50, 99]}, self._out())
        self.assertEqual(d["total"], 0)

    def test_numbers_huge_ordinal_hits_scan_cap(self):
        # A huge requested ordinal must stop at scan_cap rather than scanning the
        # whole file (efficiency guard).
        fq = self._p("t.fastq")
        write_fastq(fq, 100)
        d = run(
            fq,
            {"format": "fastq", "mode": "numbers", "numbers": [999999], "scanCap": 10},
            self._out(),
        )
        self.assertTrue(d.get("scannedToCap"))
        self.assertEqual(d["total"], 0)

    def test_header_no_prefix_collision(self):
        # "read1" must NOT match "read10"/"read12"; only the exact id.
        fq = self._p("t.fastq")
        write_fastq(fq, 20)
        d = run(fq, {"format": "fastq", "mode": "headers", "headers": ["read1"]}, self._out())
        self.assertEqual([r["header"] for r in d["reads"]], ["read1 desc1"])

    def test_fasta_misdetected_as_fastq_stops(self):
        # A FASTA file read as fastq must not emit desynced garbage.
        fa = self._p("mislabeled.fastq")
        write_fasta(fa, 5)
        d = run(fa, {"format": "fastq", "mode": "range", "start": 1, "count": 10}, self._out())
        self.assertEqual(d["total"], 0)

    # ---- headers ----

    def test_headers_found_and_missing(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 20)
        d = run(
            fq,
            {"format": "fastq", "mode": "headers", "headers": ["read7", "nope1", "read19"]},
            self._out(),
        )
        got = sorted(r["header"] for r in d["reads"])
        self.assertEqual(got, ["read19 desc19", "read7 desc7"])
        self.assertEqual(d["notFoundHeaders"], ["nope1"])

    # ---- pattern ----

    def test_pattern_case_insensitive(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 20)  # reads where i%3==0 contain AAAA
        d = run(
            fq,
            {"format": "fastq", "mode": "pattern", "pattern": "acgtAAAA", "count": 3},
            self._out(),
        )
        self.assertEqual([r["number"] for r in d["reads"]], [3, 6, 9])

    def test_pattern_no_match(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 10, seq_for=lambda i: "ACGT" * 5)
        d = run(
            fq,
            {"format": "fastq", "mode": "pattern", "pattern": "GGGGGGGG", "count": 5},
            self._out(),
        )
        self.assertEqual(d["total"], 0)

    # ---- randomize ----

    def test_randomize_plain_seek(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 200)
        d = run(
            fq,
            {"format": "fastq", "mode": "range", "randomize": True, "count": 10, "seed": 42},
            self._out(),
        )
        self.assertEqual(d["total"], 10)
        # distinct reads
        self.assertEqual(len({r["header"] for r in d["reads"]}), 10)

    def test_randomize_deterministic(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 200)
        params = {"format": "fastq", "mode": "range", "randomize": True, "count": 10, "seed": 42}
        a = run(fq, params, self._p("a.json"))
        b = run(fq, params, self._p("b.json"))
        self.assertEqual(
            [r["header"] for r in a["reads"]], [r["header"] for r in b["reads"]]
        )

    def test_randomize_gzip_reservoir(self):
        fq = self._p("t.fastq.gz")
        write_fastq(fq, 200, gzipped=True)
        d = run(
            fq,
            {"format": "fastq", "gzipped": True, "mode": "range", "randomize": True,
             "count": 8, "seed": 7},
            self._out(),
        )
        self.assertEqual(d["total"], 8)
        self.assertEqual(len({r["header"] for r in d["reads"]}), 8)

    def test_randomize_gzip_approximate_flag(self):
        fq = self._p("t.fastq.gz")
        write_fastq(fq, 50, gzipped=True)
        d = run(
            fq,
            {"format": "fastq", "gzipped": True, "mode": "range", "randomize": True,
             "count": 5, "seed": 1, "scanCap": 10},
            self._out(),
        )
        self.assertTrue(d.get("approximate"))

    # ---- gzip / formats ----

    def test_gzip_sequential(self):
        fq = self._p("t.fastq.gz")
        write_fastq(fq, 10, gzipped=True)
        d = run(
            fq,
            {"format": "fastq", "gzipped": True, "mode": "range", "start": 1, "count": 3},
            self._out(),
        )
        self.assertEqual([r["number"] for r in d["reads"]], [1, 2, 3])
        self.assertIn("quality", d["reads"][0])

    def test_fasta_no_quality_multiline(self):
        fa = self._p("t.fasta")
        write_fasta(fa, 5, seq_for=lambda i: "ACGT" * 25)
        d = run(fa, {"format": "fasta", "mode": "range", "start": 2, "count": 2}, self._out())
        self.assertEqual([r["number"] for r in d["reads"]], [2, 3])
        self.assertNotIn("quality", d["reads"][0])
        self.assertEqual(d["reads"][0]["seqLen"], 100)

    def test_fasta_randomize_seek(self):
        fa = self._p("t.fasta")
        write_fasta(fa, 50)
        d = run(
            fa,
            {"format": "fasta", "mode": "range", "randomize": True, "count": 5, "seed": 3},
            self._out(),
        )
        self.assertEqual(d["total"], 5)

    # ---- caps ----

    def test_max_reads_cap_sets_truncated(self):
        fq = self._p("t.fastq")
        write_fastq(fq, 50)
        d = run(
            fq,
            {"format": "fastq", "mode": "range", "start": 1, "count": 50, "maxReads": 5},
            self._out(),
        )
        self.assertEqual(d["total"], 5)
        self.assertTrue(d["truncated"])

    def test_long_read_emitted_in_full(self):
        # Sequences are emitted untruncated so the UI can offer a faithful FASTQ
        # download; display truncation happens UI-side.
        fq = self._p("t.fastq")
        write_fastq(fq, 3, seq_for=lambda i: "A" * 6000)
        d = run(fq, {"format": "fastq", "mode": "range", "start": 1, "count": 1}, self._out())
        rec = d["reads"][0]
        self.assertEqual(rec["seqLen"], 6000)
        self.assertEqual(len(rec["sequence"]), 6000)
        self.assertEqual(len(rec["quality"]), 6000)

    def test_payload_cap_limits_reads(self):
        # Many long reads are bounded by the payload cap, flagged via truncated.
        fq = self._p("t.fastq")
        write_fastq(fq, 500, seq_for=lambda i: "A" * 5000)
        d = run(
            fq,
            {"format": "fastq", "mode": "range", "start": 1, "count": 500,
             "maxPayloadBytes": 100000},
            self._out(),
        )
        self.assertTrue(d["truncated"])
        self.assertLess(d["total"], 500)

    # ---- empty / malformed ----

    def test_empty_file(self):
        fq = self._p("empty.fastq")
        open(fq, "w").close()
        d = run(fq, {"format": "fastq", "mode": "range", "start": 1, "count": 10}, self._out())
        self.assertEqual(d["total"], 0)

    def test_truncated_trailing_record(self):
        # last record missing its quality line — must not crash
        fq = self._p("trunc.fastq")
        with open(fq, "w") as f:
            f.write("@r1\nACGT\n+\nIIII\n@r2 partial\nACGT\n")
        d = run(fq, {"format": "fastq", "mode": "range", "start": 1, "count": 10}, self._out())
        self.assertEqual(d["total"], 1)


if __name__ == "__main__":
    unittest.main()
