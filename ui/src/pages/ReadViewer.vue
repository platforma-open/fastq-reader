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

const availableIndices = computed<string[]>(() => {
  const r = reads.value;
  if (!r) return [];
  const known = READ_INDEX_ORDER.filter((ri) => r[ri] !== undefined);
  const extra = Object.keys(r)
    .filter((k) => !READ_INDEX_ORDER.includes(k))
    .sort();
  return [...known, ...extra];
});

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

const canDownload = computed(() =>
  shownIndices.value.some((ri) => (reads.value?.[ri]?.reads.length ?? 0) > 0),
);

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function recordToText(rec: ReadRecord, fasta: boolean): string {
  if (fasta) return `>${rec.header}\n${rec.sequence}\n`;
  return `@${rec.header}\n${rec.sequence}\n+\n${rec.quality ?? ""}\n`;
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Original, full-size files for the open sample — streamed from the backend by
// PlBtnExportArchive (never built client-side; they can be many GB).
const rawFileExports = computed<FileExportEntry[]>(() => {
  const out: FileExportEntry[] = [];
  for (const e of app.model.outputs.rawFileExports ?? []) {
    if (!e.handle) continue; // narrows away the undefined handle
    out.push({
      importHandle: e.fileName as ImportFileHandle,
      blobHandle: e.handle,
      fileName: e.fileName,
    });
  }
  return out;
});

// Builds FASTQ (or FASTA) from the full reads currently in view and downloads
// one file per shown read index. Faithful — the tool emits untruncated reads.
function onDownload() {
  const fasta = isFasta.value;
  const ext = fasta ? "fasta" : "fastq";
  const base = safeName(sampleLabel.value);
  const multi = shownIndices.value.length > 1;
  for (const ri of shownIndices.value) {
    const res = reads.value?.[ri];
    if (!res || res.reads.length === 0) continue;
    const body = res.reads.map((r) => recordToText(r, fasta)).join("");
    downloadText(`${base}${multi ? `_${ri}` : ""}.${ext}`, body);
  }
}
</script>

<template>
  <!-- Raw-file download comes from the pre-run, so it's available as soon as a
       dataset + sample are selected — no Run needed. Kept separate from the
       reads controls (which require a Run). -->
  <div v-if="rawFileExports.length > 0" class="viewer-controls raw-bar">
    <PlBtnExportArchive
      :file-exports="rawFileExports"
      :disabled="rawFileExports.length === 0"
      suggested-file-name="raw-files"
    >
      Download raw files
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
        <div class="cell">{{ isFasta ? "Sequences" : shownIndices[0] }}</div>
      </div>
      <div v-for="rec in reads[shownIndices[0]]?.reads ?? []" :key="rec.number" class="grid-row">
        <pre class="cell-pre">{{ recordLines(rec) }}</pre>
      </div>
    </div>

    <!-- Paired: single scroll container, R1[i] and R2[i] on the same row so the
         two columns scroll together and pairs stay aligned. -->
    <div v-else class="reads-grid">
      <div class="grid-head">
        <div v-for="ri in shownIndices" :key="ri" class="cell">{{ ri }}</div>
      </div>
      <div v-for="row in maxRows" :key="row" class="grid-row">
        <pre v-for="ri in shownIndices" :key="ri" class="cell-pre">{{
          recordLines(reads[ri]?.reads[row - 1])
        }}</pre>
      </div>
    </div>
  </template>

  <PlAlert v-else type="info">
    Pick a dataset and sample, then press Run to view reads. Original files can be downloaded above
    as soon as a sample is selected — no Run required.
  </PlAlert>
</template>

<style scoped>
.viewer-controls {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: flex-end;
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
