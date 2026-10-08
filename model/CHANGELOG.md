# @platforma-open/milaboratories.fastq-reader.model

## 1.3.0

### Minor Changes

- ce69c85: Rename to Raw Data Reader and add Sanger AB1 support: pick one trace of a sample to view its chromatogram (dye traces, base calls, quality) or base-call sequence, and download it as .ab1 or FASTQ. The whole dataset downloads in its original format.

## 1.2.0

### Minor Changes

- 8cf759b: Add "Download whole dataset" button for the original files of every sample; name download archives after the sample / dataset; show the selected sample in the sidebar subtitle

## 1.1.1

### Patch Changes

- 0ef6cde: SDK Update

## 1.1.0

### Minor Changes

- 5a70165: Upgrade the SDK toolchain (enables building the linux/amd64 software image on Apple Silicon) and add:

  - **Download raw files without a Run** — the selected sample's original files are exposed by the pre-run, so they can be downloaded as soon as a dataset + sample are chosen. The download streams on demand from the backend and never stages the file to a workdir.
  - **Configurable scan limit** (default 2,000,000 reads) for the read-numbers, headers, pattern, and randomized-range modes. If it exceeds the file's read count, the whole file is scanned.
  - **Mate-aligned randomize** — randomized range now keeps paired R1/R2 aligned for both gzipped and uncompressed input (seeded reservoir sampling picks the same read ordinals on both sides).

  Fixes:

  - Read-header matching tooltip corrected (matches the full header or read id exactly, not as a prefix).
  - Removed the incorrect "R1/R2 are not mates" warning for randomized gzipped input, where pairs are in fact aligned.
