import type { InferOutputsType, PlRef } from "@platforma-sdk/model";
import { BlockModelV3, DataModelBuilder, isPColumnSpec } from "@platforma-sdk/model";

export type SelectionMode = "range" | "numbers" | "headers" | "pattern";

/** Hard cap on reads ever extracted/displayed, regardless of requested count. */
const MAX_READS = 5000;

/** Default number of reads scanned for search / gzip-random modes (see workflow). */
const DEFAULT_SCAN_CAP = 2_000_000;

const FASTQ_EXTENSIONS = new Set(["fastq", "fastq.gz", "fasta", "fasta.gz"]);
const FASTA_EXTENSIONS = new Set(["fasta", "fasta.gz"]);
const READ_INDEX_AXIS = "pl7.app/sequencing/readIndex";

/**
 * Read indices a dataset exposes. fastq variants carry a `pl7.app/sequencing/readIndex`
 * axis (found by name — its position varies: [sampleId, readIndex] for plain fastq,
 * [sampleId, lane, readIndex] for multilane); fasta is single-axis → one read file.
 */
function readIndicesFromSpec(spec: {
  axesSpec: { name: string; domain?: Record<string, string> }[];
}): string[] {
  const axis = spec.axesSpec.find((a) => a.name === READ_INDEX_AXIS);
  if (!axis) return ["R1"];
  const raw = axis.domain?.["pl7.app/readIndices"];
  if (!raw) return ["R1"];
  try {
    const parsed = JSON.parse(raw) as string[];
    return parsed.length > 0 ? parsed : ["R1"];
  } catch {
    return ["R1"];
  }
}

/** NaN-safe clamp — a cleared number field surfaces as NaN, which must not leak into args. */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

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
  // max reads scanned for search / gzip-random modes; ≥ file size ⇒ whole file
  scanCap: number;

  // view-only state
  pairedView: "R1" | "R2" | "both";
  contentView: "full" | "sequence";
  settingsOpen: boolean;
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
  scanCap: number;
};

export type ReadRecord = {
  number: number;
  header: string;
  sequence: string;
  seqLen: number;
  quality?: string;
};

export type ReadsResult = {
  reads: ReadRecord[];
  total: number;
  truncated: boolean;
  approximate?: boolean;
  scannedToCap?: boolean;
  notFoundHeaders?: string[];
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
  scanCap: DEFAULT_SCAN_CAP,
  pairedView: "both",
  contentView: "full",
  settingsOpen: true,
}));

export const platforma = BlockModelV3.create(dataModel)

  .args<BlockArgs>((data) => {
    if (!data.inputRef) throw new Error("Select a dataset");
    if (!data.sampleId) throw new Error("Select a sample");

    const mode = data.selectionMode;
    const numbers = parseNumbers(data.readNumbers);
    const headers = parseHeaders(data.readHeaders);
    const pattern = data.pattern.trim();
    const count = clampInt(data.count, 1, MAX_READS, 10);
    const startFrom = clampInt(data.startFrom, 1, Number.MAX_SAFE_INTEGER, 1);

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
      scanCap: clampInt(data.scanCap, 1, Number.MAX_SAFE_INTEGER, DEFAULT_SCAN_CAP),
    };
  })

  // Staging args for the raw-file download. Only the dataset + sample are needed;
  // returning these (independent of the read-selection args) lets the pre-run
  // expose the original files WITHOUT a main Run, and keeps it from re-running
  // when only the read selection changes. Undefined until both are chosen → no
  // staging yet.
  .prerunArgs((data) => {
    if (!data.inputRef || !data.sampleId) return undefined;
    return { inputRef: data.inputRef, sampleId: data.sampleId };
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

  // Sample dropdown — only the samples that belong to the chosen dataset.
  // `findLabels` is project-wide (every value of the sample-id axis across all
  // datasets), so we intersect it with this dataset's own sample ids, which the
  // column publishes in its `pl7.app/axisKeys/0` annotation.
  .output("sampleOptions", (ctx): SampleOption[] | undefined => {
    if (!ctx.data.inputRef) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    if (!spec) return undefined;
    const labels = ctx.resultPool.findLabels(spec.axesSpec[0]) ?? {};

    let ids: string[] | undefined;
    const raw = spec.annotations?.["pl7.app/axisKeys/0"];
    if (raw) {
      try {
        ids = (JSON.parse(raw) as (string | number)[]).map(String);
      } catch {
        ids = undefined;
      }
    }
    // Fallback: if the annotation is missing/unparseable, fall back to all labels.
    if (!ids) ids = Object.keys(labels);

    return ids
      .map((id) => ({ value: id, label: labels[id] ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  })

  // Read indices present in the dataset.
  .output("readIndices", (ctx): string[] | undefined => {
    if (!ctx.data.inputRef) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    if (!spec) return undefined;
    return readIndicesFromSpec(spec);
  })

  // True while the extraction workflow is computing (Run pressed, not yet done).
  .output("isRunning", (ctx): boolean => ctx.outputs?.getIsReadyOrError() === false)

  // Whether the dataset is FASTA (no per-base quality) — drives viewer presentation.
  .output("isFasta", (ctx): boolean | undefined => {
    if (!ctx.data.inputRef) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    const ext = spec?.domain?.["pl7.app/fileExtension"];
    return ext !== undefined && FASTA_EXTENSIONS.has(ext);
  })

  // Remote handles for the selected sample's ORIGINAL files. The dataset column's
  // data is not reachable from the model (only its spec is), so the PRE-RUN wraps
  // each original file as a downloadable `rawFile_<readIndex>` resource; we read
  // the on-demand handles from `ctx.prerun`. Feeds the "Download raw files"
  // button, which streams the full files (potentially many GB) from the backend.
  // Available WITHOUT a main Run — the pre-run computes as soon as a dataset +
  // sample are selected.
  .output("rawFileExports", (ctx) => {
    const prerun = ctx.prerun;
    if (!prerun || !ctx.data.inputRef || !ctx.data.sampleId) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    const indices = spec ? readIndicesFromSpec(spec) : ["R1"];
    const ext = spec?.domain?.["pl7.app/fileExtension"] ?? "fastq";
    const labels = spec ? (ctx.resultPool.findLabels(spec.axesSpec[0]) ?? {}) : {};
    const label = String(labels[ctx.data.sampleId] ?? ctx.data.sampleId);

    const out = indices.flatMap((ri) => {
      const handle = prerun
        .resolve({ field: `rawFile_${ri}`, allowPermanentAbsence: true })
        ?.getRemoteFileHandle();
      return handle ? [{ readIndex: ri, fileName: `${label}_${ri}.${ext}`, handle }] : [];
    });
    return out.length > 0 ? out : undefined;
  })

  // Extracted reads, keyed by read index. Resolve only the indices the dataset
  // actually has, with permanent-absence + non-throwing JSON read so a single-end
  // sample (only reads_R1) or an still-computing run doesn't error the output.
  .output("reads", (ctx): Record<string, ReadsResult> | undefined => {
    if (!ctx.outputs || !ctx.data.inputRef) return undefined;
    const spec = ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef);
    const indices = spec ? readIndicesFromSpec(spec) : ["R1"];
    const out: Record<string, ReadsResult> = {};
    for (const ri of indices) {
      const res = ctx.outputs
        .resolve({ field: `reads_${ri}`, allowPermanentAbsence: true })
        ?.getDataAsJson<ReadsResult>();
      if (res) out[ri] = res;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })

  // Show the sample's human-readable label (as picked in the dropdown), not its
  // raw id. Falls back to the id if the label can't be resolved yet.
  .title((ctx) => {
    if (!ctx.data.sampleId) return "FASTQ Reader";
    const spec = ctx.data.inputRef
      ? ctx.resultPool.getPColumnSpecByRef(ctx.data.inputRef)
      : undefined;
    const labels = spec ? (ctx.resultPool.findLabels(spec.axesSpec[0]) ?? {}) : {};
    const label = String(labels[ctx.data.sampleId] ?? ctx.data.sampleId);
    return `FASTQ Reader — ${label}`;
  })

  .sections((_ctx) => [{ type: "link" as const, href: "/" as const, label: "Main" }])

  .done();

export type BlockOutputs = InferOutputsType<typeof platforma>;
