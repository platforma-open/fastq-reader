<script setup lang="ts">
import type { ListOption } from "@platforma-sdk/ui-vue";
import {
  PlAlert,
  PlBtnGhost,
  PlBtnGroup,
  PlDropdown,
  PlMaskIcon24,
  ReactiveFileContent,
} from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import type { Ab1Base, Ab1Trace } from "../ab1";
import { parseAb1 } from "../ab1";
import { useApp } from "../app";
import { downloadBlob, downloadText, safeName } from "../download";
import RawDownloads from "./RawDownloads.vue";

const app = useApp();
const fileContent = ReactiveFileContent.useGlobal();

type View = "chromatogram" | "sequence";
type Zoom = "compact" | "normal" | "wide";

const viewOptions: ListOption<View>[] = [
  { label: "Chromatogram", value: "chromatogram" },
  { label: "Sequence", value: "sequence" },
];
const zoomOptions: ListOption<Zoom>[] = [
  { label: "Compact", value: "compact" },
  { label: "Normal", value: "normal" },
  { label: "Wide", value: "wide" },
];
const PX_PER_SCAN: Record<Zoom, number> = { compact: 0.5, normal: 1.2, wide: 2.4 };

// View state is optional in data (projects saved before AB1 support lack it).
const view = computed<View>({
  get: () => app.model.data.ab1View ?? "chromatogram",
  set: (v) => (app.model.data.ab1View = v),
});
const zoom = computed<Zoom>({
  get: () => app.model.data.ab1Zoom ?? "normal",
  set: (v) => (app.model.data.ab1Zoom = v),
});

const traceOptions = computed(() => app.model.outputs.traceOptions ?? []);
const selected = computed(() => app.model.outputs.selectedTrace);

// The model falls back to the sample's first trace, so the picker shows the
// trace actually on screen rather than the (possibly unset) stored key.
const traceKey = computed<string | undefined>({
  get: () => selected.value?.key,
  set: (v) => (app.model.data.traceKey = v),
});

// ---- bytes → parsed trace ----

const bytes = computed(() => {
  const handle = selected.value?.file?.handle;
  return handle ? fileContent.getContentBytes(handle).value : undefined;
});

const parsed = computed<{ trace?: Ab1Trace; error?: string }>(() => {
  if (!bytes.value) return {};
  try {
    return { trace: parseAb1(bytes.value) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});
const trace = computed(() => parsed.value.trace);

// ---- summary ----

const stats = computed(() => {
  const t = trace.value;
  if (!t || t.quality.length === 0) return undefined;
  const q = t.quality;
  const q20 = q.filter((v) => v >= 20).length;
  const mean = q.reduce((a, b) => a + b, 0) / q.length;
  return { mean: mean.toFixed(1), q20, q20Pct: ((100 * q20) / q.length).toFixed(1) };
});

// ---- chromatogram geometry ----

const BASES: Ab1Base[] = ["A", "C", "G", "T"];
const POS_Y = 12; // position numbers baseline
const QUAL_TOP = 18; // quality bars band
const QUAL_H = 24;
const LETTER_Y = QUAL_TOP + QUAL_H + 14; // base letters baseline
const TRACE_TOP = LETTER_Y + 6;
const TRACE_H = 200;
const HEIGHT = TRACE_TOP + TRACE_H + 4;
const MAX_Q = 60;

const pxPerScan = computed(() => PX_PER_SCAN[zoom.value]);
const width = computed(() => Math.ceil((trace.value?.scanCount ?? 0) * pxPerScan.value) + 8);

// Robust vertical scale: the 99.5th percentile of all intensities, so a dye
// blob or a saturated peak doesn't flatten the rest of the trace.
const yMax = computed(() => {
  const t = trace.value;
  if (!t) return 1;
  const all: number[] = [];
  for (const b of BASES) for (const v of t.traces[b]) if (v > 0) all.push(v);
  if (all.length === 0) return 1;
  all.sort((a, b) => a - b);
  return Math.max(1, all[Math.floor(all.length * 0.995)]);
});

const polylines = computed(() => {
  const t = trace.value;
  if (!t) return [];
  const sx = pxPerScan.value;
  const sy = TRACE_H / yMax.value;
  const bottom = TRACE_TOP + TRACE_H;
  return BASES.map((base) => {
    const points = Array.from(t.traces[base], (v, i) => {
      const y = Math.max(TRACE_TOP, bottom - v * sy);
      return `${(i * sx).toFixed(1)},${y.toFixed(1)}`;
    });
    return { base, points: points.join(" ") };
  });
});

/** Average pixels between neighbouring base calls — letters hide when too tight. */
const pxPerBase = computed(() => {
  const t = trace.value;
  if (!t || t.peaks.length < 2) return 0;
  return ((t.peaks[t.peaks.length - 1] - t.peaks[0]) / (t.peaks.length - 1)) * pxPerScan.value;
});
const showLetters = computed(() => pxPerBase.value >= 7);
const posStep = computed(() => (pxPerBase.value >= 7 ? 10 : 50));

const calls = computed(() => {
  const t = trace.value;
  if (!t || t.peaks.length === 0) return [];
  const sx = pxPerScan.value;
  return Array.from(t.sequence, (base, i) => {
    const q = t.quality[i];
    return {
      i,
      x: t.peaks[i] * sx,
      base,
      q,
      qh: q === undefined ? 0 : (Math.min(q, MAX_Q) / MAX_Q) * QUAL_H,
      tier: q === undefined ? "" : q >= 30 ? "q-high" : q >= 20 ? "q-mid" : "q-low",
    };
  });
});

const positionTicks = computed(() => calls.value.filter((c) => (c.i + 1) % posStep.value === 0));

// ---- sequence view ----

const LINE = 60;
/** Lines of the base calls, with runs below Q20 marked for dimming. */
const sequenceLines = computed(() => {
  const t = trace.value;
  if (!t) return [];
  const lines: { pos: number; runs: { text: string; low: boolean }[] }[] = [];
  for (let start = 0; start < t.sequence.length; start += LINE) {
    const runs: { text: string; low: boolean }[] = [];
    for (let i = start; i < Math.min(start + LINE, t.sequence.length); i++) {
      const low = t.quality.length > 0 && t.quality[i] < 20;
      const last = runs[runs.length - 1];
      if (last && last.low === low) last.text += t.sequence[i];
      else runs.push({ text: t.sequence[i], low });
    }
    lines.push({ pos: start + 1, runs });
  }
  return lines;
});

// ---- downloads ----

const fileBase = computed(() => {
  const id = app.model.data.sampleId;
  const sample = (app.model.outputs.sampleOptions ?? []).find((o) => o.value === id)?.label;
  const parts = [sample ?? id ?? "trace"];
  if (traceOptions.value.length > 1 && selected.value) parts.push(selected.value.label);
  return safeName(parts.join("_"));
});

function onDownloadAb1() {
  if (!bytes.value) return;
  downloadBlob(`${fileBase.value}.ab1`, new Blob([bytes.value as BlobPart]));
}

function onDownloadFastq() {
  const t = trace.value;
  if (!t) return;
  const qual =
    t.quality.length > 0
      ? t.quality.map((q) => String.fromCharCode(Math.min(q, 93) + 33)).join("")
      : "I".repeat(t.sequence.length);
  downloadText(`${fileBase.value}.fastq`, `@${fileBase.value}\n${t.sequence}\n+\n${qual}\n`);
}
</script>

<template>
  <RawDownloads />

  <PlAlert v-if="!app.model.data.sampleId" type="info">
    Pick a sample in Settings to view its Sanger traces.
  </PlAlert>

  <template v-else>
    <div class="viewer-controls">
      <PlDropdown
        v-if="traceOptions.length > 1"
        v-model="traceKey"
        :options="traceOptions"
        label="Trace"
        class="trace-picker"
      />
      <PlBtnGroup v-model="view" :options="viewOptions" label="View" />
      <PlBtnGroup
        v-if="view === 'chromatogram'"
        v-model="zoom"
        :options="zoomOptions"
        label="Zoom"
      />
      <PlBtnGhost :disabled="!bytes" @click="onDownloadAb1">
        Download .ab1
        <template #append><PlMaskIcon24 name="download" /></template>
      </PlBtnGhost>
      <PlBtnGhost :disabled="!trace" @click="onDownloadFastq">
        Download FASTQ
        <template #append><PlMaskIcon24 name="download" /></template>
      </PlBtnGhost>
    </div>

    <PlAlert v-if="parsed.error" type="error">
      Could not read this trace: {{ parsed.error }}
    </PlAlert>
    <PlAlert v-else-if="!selected" type="info">Loading the sample's traces…</PlAlert>
    <PlAlert v-else-if="!trace" type="info">Loading trace…</PlAlert>

    <template v-if="trace">
      <dl class="summary">
        <div>
          <dt>Length</dt>
          <dd>{{ trace.sequence.length }} bp</dd>
        </div>
        <template v-if="stats">
          <div>
            <dt>Mean quality</dt>
            <dd>Q{{ stats.mean }}</dd>
          </div>
          <div>
            <dt>Bases ≥ Q20</dt>
            <dd>{{ stats.q20 }} ({{ stats.q20Pct }}%)</dd>
          </div>
        </template>
        <div v-for="m in trace.meta" :key="m.label">
          <dt>{{ m.label }}</dt>
          <dd>{{ m.value }}</dd>
        </div>
      </dl>

      <div v-if="view === 'chromatogram'" class="chromatogram">
        <svg :width="width" :height="HEIGHT" :viewBox="`0 0 ${width} ${HEIGHT}`">
          <text
            v-for="c in positionTicks"
            :key="`p${c.i}`"
            :x="c.x"
            :y="POS_Y"
            class="pos"
            text-anchor="middle"
          >
            {{ c.i + 1 }}
          </text>
          <rect
            v-for="c in calls"
            :key="`q${c.i}`"
            :x="c.x - Math.max(1, pxPerBase * 0.35)"
            :y="QUAL_TOP + QUAL_H - c.qh"
            :width="Math.max(1, pxPerBase * 0.7)"
            :height="c.qh"
            :class="['qbar', c.tier]"
          >
            <title>#{{ c.i + 1 }} {{ c.base }} Q{{ c.q }}</title>
          </rect>
          <template v-if="showLetters">
            <text
              v-for="c in calls"
              :key="`b${c.i}`"
              :x="c.x"
              :y="LETTER_Y"
              :class="['call', `base-${c.base}`]"
              text-anchor="middle"
            >
              {{ c.base }}
            </text>
          </template>
          <polyline
            v-for="p in polylines"
            :key="p.base"
            :points="p.points"
            :class="['trace', `base-${p.base}`]"
          />
        </svg>
      </div>

      <div v-else class="sequence">
        <div class="seq-head">&gt;{{ fileBase }} · bases below Q20 dimmed</div>
        <pre
          class="seq-pre"
        ><template v-for="line in sequenceLines" :key="line.pos"><span class="seq-pos">{{ String(line.pos).padStart(5, " ") }}  </span><template v-for="(r, k) in line.runs" :key="k"><span :class="{ 'seq-low': r.low }">{{ r.text }}</span></template>
</template></pre>
      </div>
    </template>
  </template>
</template>

<style scoped>
.viewer-controls {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: flex-end;
  margin-bottom: 12px;
}
.trace-picker {
  min-width: 220px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 24px;
  margin: 0 0 12px;
  font-size: 12px;
}
.summary dt {
  color: var(--txt-03, #6b7280);
}
.summary dd {
  margin: 0;
  font-weight: 600;
}
.chromatogram,
.sequence {
  overflow: auto;
  border: 1px solid var(--border-color-default, #e0e0e0);
  border-radius: 6px;
}
.chromatogram svg {
  display: block;
  /* Standard Sanger palette; G is drawn in the text colour so it reads in both themes. */
  --base-A: #1b9e3e;
  --base-C: #2563eb;
  --base-G: var(--txt-01, #111);
  --base-T: #dc2626;
}
.trace {
  fill: none;
  stroke-width: 1;
}
.trace.base-A {
  stroke: var(--base-A);
}
.trace.base-C {
  stroke: var(--base-C);
}
.trace.base-G {
  stroke: var(--base-G);
}
.trace.base-T {
  stroke: var(--base-T);
}
.call {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
}
.call.base-A {
  fill: var(--base-A);
}
.call.base-C {
  fill: var(--base-C);
}
.call.base-G {
  fill: var(--base-G);
}
.call.base-T {
  fill: var(--base-T);
}
.pos {
  font-size: 10px;
  fill: var(--txt-03, #6b7280);
}
.qbar.q-high {
  fill: #93c5fd;
}
.qbar.q-mid {
  fill: #fcd34d;
}
.qbar.q-low {
  fill: #fca5a5;
}
.seq-head {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--txt-03, #6b7280);
  border-bottom: 1px solid var(--border-color-div, #f0f0f0);
}
.seq-pre {
  margin: 0;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.seq-pos {
  color: var(--txt-03, #6b7280);
}
.seq-low {
  opacity: 0.4;
}
</style>
