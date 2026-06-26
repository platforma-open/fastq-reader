# FASTQ Reader

Inspect the raw reads of a sequencing dataset imported with **Samples & Data**.

Pick a dataset and a sample, choose which reads to look at, and see them rendered exactly as
they appear in the file. The block streams the input and reads only what it needs — it never
loads or outputs whole files, so it stays fast on multi-gigabyte FASTQ inputs.

## Read selection

- **Range** — a number of reads starting from a given position, optionally **randomized**
  across the file instead of taken sequentially.
- **Read numbers** — specific reads by their 1-based position.
- **Read headers** — reads whose header matches the text you provide.
- **Sequence pattern** — reads whose sequence contains a given subsequence.

## Viewing

- For paired-end data, view **R1**, **R2**, or both mates side by side.
- Toggle between the **full record** (header, sequence, and quality) and **sequence only**.
