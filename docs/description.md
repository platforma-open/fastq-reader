# Raw Data Reader

Inspect the raw data of a sequencing dataset imported with **Samples & Data**: the reads of a
FASTQ/FASTA dataset, or the Sanger chromatograms of an AB1 dataset.

## FASTQ / FASTA

Pick a dataset and a sample, choose which reads to look at, and see them rendered exactly as
they appear in the file. The block streams the input and reads only what it needs — it never
loads or outputs whole files, so it stays fast on multi-gigabyte FASTQ inputs.

### Read selection

- **Range** — a number of reads starting from a given position, optionally **randomized**
  across the file instead of taken sequentially.
- **Read numbers** — specific reads by their 1-based position.
- **Read headers** — reads whose header matches the text you provide.
- **Sequence pattern** — reads whose sequence contains a given subsequence.

### Viewing

- For paired-end data, view **R1**, **R2**, or both mates side by side.
- Toggle between the **full record** (header, sequence, and quality) and **sequence only**.

## Sanger AB1

Pick an AB1 dataset and a sample, then choose one of the sample's traces (for example the
forward or reverse primer read). No Run is needed — the trace opens as soon as it is selected.

- **Chromatogram** — the four dye traces with base calls and per-base quality bars, at three
  zoom levels.
- **Sequence** — the base calls, with bases below Q20 dimmed, plus run details (instrument,
  basecaller, run date) and quality summary.
- Download the trace as the original **.ab1** file or as **FASTQ** (base calls + qualities).

## Downloads

The original files — for the selected sample or the whole dataset — can be downloaded in their
original format as soon as a dataset is selected, without running the block.
