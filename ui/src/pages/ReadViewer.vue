<script setup lang="ts">
import type { ReadRecord, ReadsResult } from "@platforma-open/milaboratories.fastq-reader.model";
import type { ListOption } from "@platforma-sdk/ui-vue";
import { PlAlert, PlBtnGhost, PlBtnGroup, PlMaskIcon24 } from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import { useApp } from "../app";
import { downloadBlob, downloadText, safeName, zipStored } from "../download";
import RawDownloads from "./RawDownloads.vue";

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

function recordToText(rec: ReadRecord, fasta: boolean): string {
  if (fasta) return `>${rec.header}\n${rec.sequence}\n`;
  return `@${rec.header}\n${rec.sequence}\n+\n${rec.quality ?? ""}\n`;
}

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
  <!-- Original files come from the pre-run, so they're available as soon as a
       dataset is selected — no Run needed. -->
  <RawDownloads />

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
