<script setup lang="ts">
import type { ReadRecord, ReadsResult } from "@platforma-open/milaboratories.fastq-reader.model";
import type { ImportFileHandle } from "@platforma-sdk/model";
import type { FileExportEntry, ListOption } from "@platforma-sdk/ui-vue";
import {
  PlAlert,
  PlBtnExportArchive,
  PlBtnGhost,
  PlBtnGroup,
  PlMaskIcon24,
} from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import { useApp } from "../app";

const app = useApp();

const READ_INDEX_ORDER = ["R1", "R2", "I1", "I2"];
/** Max characters of a sequence/quality rendered per read (display only — the
 *  full read is kept in memory for a faithful download). */
const DISPLAY_LIMIT = 2000;

const contentOptions: ListOption<"full" | "sequence">[] = [
  { label: "Full record", value: "full" },
  { label: "Sequence only", value: "sequence" },
];
const pairedOptions: ListOption<"R1" | "R2" | "both">[] = [
  { label: "R1", value: "R1" },
  { label: "R2", value: "R2" },
  { label: "Both", value: "both" },
];

const reads = computed<Record<string, ReadsResult> | undefined>(() => app.model.outputs.reads);
const isFasta = computed(() => app.model.outputs.isFasta ?? false);

// Column layout is driven by the dataset's DECLARED read indices (known up
// front), not by which extractions have resolved so far. R1 and R2 are separate
// runs and finish at different times; keying off resolved reads made the table
// briefly show only R1 and then flip to two columns. Falls back to resolved
// reads if the declared list isn't available yet.
const expectedIndices = computed<string[]>(() => app.model.outputs.readIndices ?? []);

const availableIndices = computed<string[]>(() => {
  const src =
    expectedIndices.value.length > 0 ? expectedIndices.value : Object.keys(reads.value ?? {});
  const known = READ_INDEX_ORDER.filter((ri) => src.includes(ri));
  const extra = src.filter((k) => !READ_INDEX_ORDER.includes(k)).sort();
  return [...known, ...extra];
});

/** A shown index whose extraction hasn't resolved yet (e.g. R2 still running). */
function isIndexPending(ri: string): boolean {
  return reads.value?.[ri] === undefined;
}

const isPaired = computed(
  () => availableIndices.value.includes("R1") && availableIndices.value.includes("R2"),
);

const shownIndices = computed<string[]>(() => {
  const avail = availableIndices.value;
  if (!isPaired.value) return avail.slice(0, 1);
  const v = app.model.data.pairedView;
  if (v === "both") return ["R1", "R2"];
  return avail.includes(v) ? [v] : avail.slice(0, 1);
});

const maxRows = computed(() =>
  Math.max(0, ...shownIndices.value.map((ri) => reads.value?.[ri]?.reads.length ?? 0)),
);

/** Lines for one read, with sequence/quality truncated for display only. */
function recordLines(rec: ReadRecord | undefined): string {
  if (!rec) return "";
  const truncated = rec.seqLen > DISPLAY_LIMIT;
  const seq = truncated ? rec.sequence.slice(0, DISPLAY_LIMIT) : rec.sequence;
  const tail = truncated ? ` … (${rec.seqLen} bp)` : "";
  if (app.model.data.contentView === "sequence") {
    return seq + tail;
  }
  if (rec.quality === undefined) {
    return `>${rec.header}\n${seq}${tail}`;
  }
  const qual = truncated ? rec.quality.slice(0, DISPLAY_LIMIT) + " …" : rec.quality;
  return `@${rec.header}\n${seq}${tail}\n+\n${qual}`;
}

type Notice = { type: "info" | "warn"; text: string };
const notices = computed<Notice[]>(() => {
  const out: Notice[] = [];
  const r = reads.value;
  if (!r) return out;
  for (const ri of shownIndices.value) {
    const res = r[ri];
    if (!res) continue;
    if (res.truncated)
      out.push({ type: "warn", text: `${ri}: showing the first ${res.total} reads (capped).` });
    if (res.approximate)
      out.push({
        type: "warn",
        text: `${ri}: randomized over the scanned portion of the file (gzip has no random access).`,
      });
    if (res.scannedToCap)
      out.push({
        type: "warn",
        text: `${ri}: stopped after the scan limit before all matches were found.`,
      });
    if (res.notFoundHeaders && res.notFoundHeaders.length > 0)
      out.push({
        type: "warn",
        text: `${ri}: headers not found: ${res.notFoundHeaders.join(", ")}.`,
      });
  }
  if (isPaired.value && app.model.data.pairedView === "both") {
    const mode = app.model.data.selectionMode;
    // Range (sequential and randomized) and read-numbers keep R1/R2 aligned by
    // ordinal. Only content-based selection can pick unrelated reads per side.
    if (mode === "headers" || mode === "pattern") {
      out.push({
        type: "info",
        text: "In this mode R1 and R2 are matched independently, so reads shown side by side may not be mates. Use sequential range or read numbers for aligned pairs.",
      });
    }
  }
  return out;
});

// ---- download ----

const sampleLabel = computed(() => {
  const id = app.model.data.sampleId;
  const opt = (app.model.outputs.sampleOptions ?? []).find((o) => o.value === id);
  return opt?.label ?? id ?? "reads";
});

// Read indices that actually have extracted reads — this is what "Download
// selected" exports (the full pair for paired data), independent of the R1/R2/
// Both view toggle, which only controls what's shown on screen.
const downloadableIndices = computed<string[]>(() =>
  availableIndices.value.filter((ri) => (reads.value?.[ri]?.reads.length ?? 0) > 0),
);

const canDownload = computed(() => downloadableIndices.value.length > 0);

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function recordToText(rec: ReadRecord, fasta: boolean): string {
  if (fasta) return `>${rec.header}\n${rec.sequence}\n`;
  return `@${rec.header}\n${rec.sequence}\n+\n${rec.quality ?? ""}\n`;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Anchor must be in the DOM for click() to reliably trigger a download, and
  // revoking the URL too early can cancel it — defer the revoke.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function downloadText(filename: string, text: string) {
  downloadBlob(filename, new Blob([text], { type: "text/plain" }));
}

// --- minimal stored (uncompressed) ZIP -------------------------------------
// Bundling the pair into one archive avoids the browser/Electron dropping the
// second of two rapid downloads. Selections are small and bounded, so "stored"
// (no compression) is fine and keeps this dependency-free.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function zipStored(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lfh = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      name,
    ]);
    local.push(lfh, f.data);
    central.push(
      concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += lfh.length + size;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]);
  const all = concatBytes([...local, ...central, eocd]);
  return new Blob([all as BlobPart], { type: "application/zip" });
}

// Original, full-size files — streamed from the backend by PlBtnExportArchive
// (never built client-side; they can be many GB). `rawFileExports` covers the
// open sample, `datasetFileExports` every sample of the selected dataset.
function toFileExports(
  entries: { fileName: string; handle?: FileExportEntry["blobHandle"] }[] | undefined,
): FileExportEntry[] {
  const out: FileExportEntry[] = [];
  for (const e of entries ?? []) {
    if (!e.handle) continue; // narrows away the undefined handle
    out.push({
      importHandle: e.fileName as ImportFileHandle,
      blobHandle: e.handle,
      fileName: e.fileName,
    });
  }
  return out;
}

const rawFileExports = computed<FileExportEntry[]>(() =>
  toFileExports(app.model.outputs.rawFileExports),
);

const datasetFileExports = computed<FileExportEntry[]>(() =>
  toFileExports(app.model.outputs.datasetFileExports),
);

const sampleArchiveName = computed(() => `${safeName(sampleLabel.value)}-raw-files.zip`);

// Names the dataset archive. The dataset's own label lives on the dropdown
// option, not on its spec, so it is read back from the options list.
const datasetArchiveName = computed(() => {
  const ref = app.model.data.inputRef;
  const label = ref
    ? (app.model.outputs.inputOptions ?? []).find(
        (o) => o.ref.blockId === ref.blockId && o.ref.name === ref.name,
      )?.label
    : undefined;
  return `${safeName(label ?? "dataset")}-raw-files.zip`;
});

// Builds FASTQ (or FASTA) from the extracted reads. A single read index is
// downloaded as one file; paired data (both R1 and R2) is bundled into one zip
// so the full pair is saved in a single download — regardless of the view
// toggle. Faithful — the tool emits untruncated reads.
function onDownload() {
  const fasta = isFasta.value;
  const ext = fasta ? "fasta" : "fastq";
  const base = safeName(sampleLabel.value);
  const indices = downloadableIndices.value;
  if (indices.length === 0) return;

  const bodyFor = (ri: string) =>
    (reads.value?.[ri]?.reads ?? []).map((r) => recordToText(r, fasta)).join("");

  if (indices.length === 1) {
    downloadText(`${base}.${ext}`, bodyFor(indices[0]));
    return;
  }

  const enc = new TextEncoder();
  const files = indices.map((ri) => ({
    name: `${base}_${ri}.${ext}`,
    data: enc.encode(bodyFor(ri)),
  }));
  downloadBlob(`${base}.zip`, zipStored(files));
}
</script>

<template>
  <!-- Raw-file downloads come from the pre-run, so they're available as soon as
       a dataset is selected — no Run needed. Kept separate from the reads
       controls (which require a Run). -->
  <div v-if="datasetFileExports.length > 0" class="viewer-controls raw-bar">
    <PlBtnExportArchive
      v-if="rawFileExports.length > 0"
      :file-exports="rawFileExports"
      :suggested-file-name="sampleArchiveName"
    >
      Download raw files
    </PlBtnExportArchive>

    <PlBtnExportArchive
      :file-exports="datasetFileExports"
      :suggested-file-name="datasetArchiveName"
    >
      Download whole dataset ({{ datasetFileExports.length }} files)
    </PlBtnExportArchive>
  </div>

  <template v-if="reads">
    <div class="viewer-controls">
      <PlBtnGroup
        v-if="isPaired"
        v-model="app.model.data.pairedView"
        :options="pairedOptions"
        label="Reads"
      />
      <PlBtnGroup v-model="app.model.data.contentView" :options="contentOptions" label="View" />
      <PlBtnGhost :disabled="!canDownload" @click="onDownload">
        Download selected {{ isFasta ? "FASTA" : "FASTQ" }}
        <template #append><PlMaskIcon24 name="download" /></template>
      </PlBtnGhost>
    </div>

    <PlAlert v-for="(n, i) in notices" :key="i" :type="n.type === 'warn' ? 'warn' : 'info'">
      {{ n.text }}
    </PlAlert>

    <!-- Single column (single-end / fasta / R1-only / R2-only) -->
    <div v-if="shownIndices.length === 1" class="reads-grid">
      <div class="grid-head">
        <div class="cell">
          {{ isFasta ? "Sequences" : shownIndices[0] }}
          <span v-if="isIndexPending(shownIndices[0])" class="pending-tag">· loading…</span>
        </div>
      </div>
      <div v-for="rec in reads[shownIndices[0]]?.reads ?? []" :key="rec.number" class="grid-row">
        <pre class="cell-pre">{{ recordLines(rec) }}</pre>
      </div>
    </div>

    <!-- Paired: single scroll container, R1[i] and R2[i] on the same row so the
         two columns scroll together and pairs stay aligned. -->
    <div v-else class="reads-grid">
      <div class="grid-head">
        <div v-for="ri in shownIndices" :key="ri" class="cell">
          {{ ri }}<span v-if="isIndexPending(ri)" class="pending-tag">· loading…</span>
        </div>
      </div>
      <div v-for="row in maxRows" :key="row" class="grid-row">
        <pre v-for="ri in shownIndices" :key="ri" class="cell-pre">{{
          recordLines(reads[ri]?.reads[row - 1])
        }}</pre>
      </div>
    </div>
  </template>

  <PlAlert v-else type="info">
    Pick a dataset and sample, then press Run to view reads. The original files, for one sample or
    the whole dataset, can be downloaded as soon as a dataset is selected — no Run required.
  </PlAlert>
</template>

<style scoped>
.viewer-controls {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: flex-end;
}
.pending-tag {
  margin-left: 6px;
  font-weight: 400;
  font-size: 11px;
  color: var(--txt-03, #6b7280);
}
.raw-bar {
  margin-bottom: 12px;
}
.reads-grid {
  max-height: 60vh;
  overflow: auto;
  border: 1px solid var(--border-color-default, #e0e0e0);
  border-radius: 6px;
}
.grid-head {
  display: flex;
  gap: 16px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-base, #fff);
  border-bottom: 1px solid var(--border-color-default, #e0e0e0);
  padding: 6px 8px;
}
.grid-row {
  display: flex;
  gap: 16px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color-div, #f0f0f0);
}
.cell {
  flex: 1 1 0;
  min-width: 0;
  font-weight: 600;
}
.cell-pre {
  flex: 1 1 0;
  min-width: 0;
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre;
  overflow-x: auto;
}
</style>
