<script setup lang="ts">
import type { ImportFileHandle } from "@platforma-sdk/model";
import type { FileExportEntry } from "@platforma-sdk/ui-vue";
import { PlBtnExportArchive } from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import { useApp } from "../app";
import { safeName } from "../download";

const app = useApp();

// Original, full-size files — streamed from the backend by PlBtnExportArchive
// (never built client-side; they can be many GB). `rawFileExports` covers the
// open sample, `datasetFileExports` every sample of the selected dataset. Both
// come from the pre-run, so they're available without a Run.
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

const sampleLabel = computed(() => {
  const id = app.model.data.sampleId;
  const opt = (app.model.outputs.sampleOptions ?? []).find((o) => o.value === id);
  return opt?.label ?? id ?? "sample";
});

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
</script>

<template>
  <div v-if="datasetFileExports.length > 0" class="raw-bar">
    <PlBtnExportArchive
      v-if="rawFileExports.length > 0"
      :file-exports="rawFileExports"
      :suggested-file-name="sampleArchiveName"
    >
      Download sample files ({{ rawFileExports.length }})
    </PlBtnExportArchive>

    <PlBtnExportArchive
      :file-exports="datasetFileExports"
      :suggested-file-name="datasetArchiveName"
    >
      Download whole dataset ({{ datasetFileExports.length }} files)
    </PlBtnExportArchive>
  </div>
</template>

<style scoped>
.raw-bar {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: flex-end;
  margin-bottom: 12px;
}
</style>
