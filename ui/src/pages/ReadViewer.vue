<script setup lang="ts">
import type { ReadRecord, ReadsResult } from "@platforma-open/milaboratories.fastq-reader.model";
import type { ListOption } from "@platforma-sdk/ui-vue";
import { PlAlert, PlBtnGroup } from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import { useApp } from "../app";

const app = useApp();

const READ_INDEX_ORDER = ["R1", "R2", "I1", "I2"];

const contentOptions: ListOption<"full" | "sequence">[] = [
  { label: "Full record", value: "full" },
  { label: "Sequence only", value: "sequence" },
];

const reads = computed<Record<string, ReadsResult> | undefined>(() => app.model.outputs.reads);

/** Read indices that actually returned results, in a stable display order. */
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

const pairedOptions = computed<ListOption<"R1" | "R2" | "both">[]>(() => [
  { label: "R1", value: "R1" },
  { label: "R2", value: "R2" },
  { label: "Both", value: "both" },
]);

/** Indices to actually render given the paired-view toggle. */
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

// Derived from the dataset spec (not inferred from a read), so it's correct even
// when the current selection returns zero reads.
const isFasta = computed(() => app.model.outputs.isFasta ?? false);

function recordLines(rec: ReadRecord | undefined): string[] {
  if (!rec) return [];
  const tail = rec.seqTruncated ? ` … (${rec.seqLen} bp)` : "";
  if (app.model.data.contentView === "sequence") {
    return [rec.sequence + tail];
  }
  if (rec.quality === undefined) {
    // fasta
    return [`>${rec.header}`, rec.sequence + tail];
  }
  return [`@${rec.header}`, rec.sequence + tail, "+", rec.quality + (rec.seqTruncated ? " …" : "")];
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
  // The two columns are aligned by row index. Pairs are true mates only when the
  // same ordinals are read from each file — i.e. sequential range or read-numbers.
  // Randomize, headers, and pattern match each mate independently, so warn.
  if (isPaired.value && app.model.data.pairedView === "both") {
    const mode = app.model.data.selectionMode;
    if (mode === "range" && app.model.data.randomize) {
      out.push({
        type: "info",
        text: "Under Randomize, R1 and R2 are independent random samples — not mates. Use sequential range or read numbers to see aligned pairs.",
      });
    } else if (mode === "headers" || mode === "pattern") {
      out.push({
        type: "info",
        text: "In this mode R1 and R2 are matched independently, so reads shown side by side may not be mates. Use sequential range or read numbers for aligned pairs.",
      });
    }
  }
  return out;
});
</script>

<template>
  <template v-if="reads">
    <div class="viewer-controls">
      <PlBtnGroup
        v-if="isPaired"
        v-model="app.model.data.pairedView"
        :options="pairedOptions"
        label="Reads"
      />
      <PlBtnGroup v-model="app.model.data.contentView" :options="contentOptions" label="View" />
    </div>

    <PlAlert v-for="(n, i) in notices" :key="i" :type="n.type === 'warn' ? 'warn' : 'info'">
      {{ n.text }}
    </PlAlert>

    <!-- Single column -->
    <div v-if="shownIndices.length === 1" class="reads-single">
      <div class="col-header">{{ isFasta ? "Sequences" : shownIndices[0] }}</div>
      <pre class="reads"><template
        v-for="rec in reads[shownIndices[0]]?.reads ?? []"
        :key="rec.number"
      ><span class="read-block">{{ recordLines(rec).join("\n") }}</span>
</template></pre>
    </div>

    <!-- Two columns side by side, row-aligned by read index -->
    <div v-else class="reads-paired">
      <div v-for="ri in shownIndices" :key="ri" class="reads-col">
        <div class="col-header">{{ ri }}</div>
        <pre class="reads"><template
          v-for="row in maxRows"
          :key="row"
        ><span class="read-block">{{ recordLines(reads[ri]?.reads[row - 1]).join("\n") }}</span>
</template></pre>
      </div>
    </div>
  </template>

  <PlAlert v-else type="info">
    Pick a dataset and sample, choose reads, then press Run to view them.
  </PlAlert>
</template>

<style scoped>
.viewer-controls {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: flex-end;
}
.reads-paired {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.reads-col {
  flex: 1 1 0;
  min-width: 0;
}
.col-header {
  font-weight: 600;
  margin-bottom: 4px;
}
.reads {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre;
  overflow-x: auto;
  max-height: 60vh;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border-color-default, #e0e0e0);
  border-radius: 6px;
  margin: 0;
}
.read-block {
  display: block;
  padding-bottom: 6px;
}
</style>
