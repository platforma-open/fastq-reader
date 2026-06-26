import type { InferOutputsType, PlRef } from "@platforma-sdk/model";
import { BlockModelV3, DataModelBuilder, isPColumnSpec } from "@platforma-sdk/model";

export type SelectionMode = "range" | "numbers" | "headers" | "pattern";

/** Hard cap on reads ever extracted/displayed, regardless of requested count. */
const MAX_READS = 5000;

const FASTQ_EXTENSIONS = new Set(["fastq", "fastq.gz", "fasta", "fasta.gz"]);

/** UI-shaped, persisted state. View toggles live here and never reach the workflow. */
export type BlockData = {
  inputRef?: PlRef;
  sampleId?: string;

  selectionMode: SelectionMode;
  // range mode
  count: number;
  startFrom: number;
  randomize: boolean;
  // numbers / headers / pattern modes — raw text as typed by the user
  readNumbers: string;
  readHeaders: string;
  pattern: string;

  // view-only state
  pairedView: "R1" | "R2" | "both";
  contentView: "full" | "sequence";
};

/** Projected workflow input. */
export type BlockArgs = {
  inputRef: PlRef;
  sampleId: string;
  selectionMode: SelectionMode;
  count: number;
  startFrom: number;
  randomize: boolean;
  readNumbers: number[];
  readHeaders: string[];
  pattern: string;
  maxReads: number;
};

export type ReadRecord = {
  number: number;
  header: string;
  sequence: string;
  seqLen: number;
  seqTruncated?: boolean;
  quality?: string;
};

export type ReadsResult = {
  reads: ReadRecord[];
  total: number;
  truncated: boolean;
  approximate?: boolean;
  scannedToCap?: boolean;
  notFoundHeaders?: string[];
  randomByOffset?: boolean;
};

export type SampleOption = { value: string; label: string };

const parseNumbers = (text: string): number[] => {
  const out = new Set<number>();
  for (const tok of text.split(/[\s,]+/)) {
    if (!tok) continue;
    const n = Number(tok);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
};

const parseHeaders = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split(/[\n,]+/)) {
    const h = line.trim();
    if (h) out.push(h);
  }
  return out;
};

const dataModel = new DataModelBuilder().from<BlockData>("v1").init(() => ({
  inputRef: undefined,
  sampleId: undefined,
  selectionMode: "range",
  count: 10,
  startFrom: 1,
  randomize: false,
  readNumbers: "",
  readHeaders: "",
  pattern: "",
  pairedView: "both",
  contentView: "full",
}));

export const platforma = BlockModelV3.create(dataModel)

  .args<BlockArgs>((data) => {
    if (!data.inputRef) throw new Error("Select a dataset");
    if (!data.sampleId) throw new Error("Select a sample");

    const mode = data.selectionMode;
    const numbers = parseNumbers(data.readNumbers);
    const headers = parseHeaders(data.readHeaders);
    const pattern = data.pattern.trim();
    const count = Math.max(1, Math.min(MAX_READS, Math.floor(data.count)));
    const startFrom = Math.max(1, Math.floor(data.startFrom));

    if (mode === "numbers" && numbers.length === 0)
      throw new Error("Enter at least one read number");
    if (mode === "headers" && headers.length === 0)
      throw new Error("Enter at least one read header");
    if (mode === "pattern" && pattern === "") throw new Error("Enter a sequence pattern");

    // Canonicalize: only project the fields the active mode actually uses, so
    // editing an inactive mode's field never stales the block.
    const maxReadsFor =
      mode === "numbers"
        ? Math.min(MAX_READS, numbers.length)
        : mode === "headers"
          ? Math.min(MAX_READS, headers.length)
          : count;

    return {
      inputRef: data.inputRef,
      sampleId: data.sampleId,
      selectionMode: mode,
      count: mode === "range" || mode === "pattern" ? count : 0,
      startFrom: mode === "range" ? startFrom : 1,
      randomize: mode === "range" ? data.randomize : false,
      readNumbers: mode === "numbers" ? numbers : [],
      readHeaders: mode === "headers" ? headers : [],
      pattern: mode === "pattern" ? pattern : "",
      maxReads: maxReadsFor,
    };
  })

  // Dataset dropdown — same filter as fastqc, widened to fasta.
  .output("inputOptions", (ctx) =>
    ctx.resultPool.getOptions((v) => {
      if (!isPColumnSpec(v)) return false;
      const ext = v.domain?.["pl7.app/fileExtension"];
      return (
        v.name === "pl7.app/sequencing/data" &&
        (v.valueType as string) === "File" &&
        ext !== undefined &&
        FASTQ_EXTENSIONS.has(ext)
      );
    }),
  )

  // Sample dropdown — labels for the sample-id axis of the chosen dataset.
  .output("sampleOptions", (ctx): SampleOption[] | undefined => {
    if (!ctx.data.inputRef) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    if (!spec) return undefined;
    const labels = ctx.findLabels(spec.axesSpec[0]);
    if (!labels) return undefined;
    return Object.entries(labels)
      .map(([value, label]) => ({ value: String(value), label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  })

  // Read indices present in the dataset. fastq carries them on axis 1; fasta is
  // single-axis and treated as one read file ("R1").
  .output("readIndices", (ctx): string[] | undefined => {
    if (!ctx.data.inputRef) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    if (!spec) return undefined;
    if (spec.axesSpec.length < 2) return ["R1"];
    const raw = spec.axesSpec[1].domain?.["pl7.app/readIndices"];
    if (!raw) return ["R1"];
    try {
      const parsed = JSON.parse(raw) as string[];
      return parsed.length > 0 ? parsed : ["R1"];
    } catch {
      return ["R1"];
    }
  })

  // Extracted reads, keyed by read index (R1, R2, …).
  .output("reads", (ctx): Record<string, ReadsResult> | undefined => {
    if (!ctx.outputs) return undefined;
    const out: Record<string, ReadsResult> = {};
    for (const ri of ["R1", "R2", "I1", "I2"]) {
      const res = ctx.outputs.resolve(`reads_${ri}`)?.getDataAsJson<ReadsResult>();
      if (res) out[ri] = res;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })

  .title((ctx) => (ctx.data.sampleId ? `FASTQ Reader — ${ctx.data.sampleId}` : "FASTQ Reader"))

  .sections((_ctx) => [{ type: "link" as const, href: "/" as const, label: "Main" }])

  .done();

export type BlockOutputs = InferOutputsType<typeof platforma>;
