<script setup lang="ts">
import { PlBlockPage, PlBtnGhost, PlMaskIcon24, PlSlideModal } from "@platforma-sdk/ui-vue";
import { watchEffect } from "vue";
import { BLOCK_TITLE } from "@platforma-open/milaboratories.fastq-reader.model";
import { useApp } from "../app";
import Ab1Viewer from "./Ab1Viewer.vue";
import ReadViewer from "./ReadViewer.vue";
import SettingsPanel from "./SettingsPanel.vue";

const app = useApp();

// Keep the stored label (read by the sidebar subtitle) in step with the
// sample's current label: it can be renamed after selection, and data saved
// before the field existed has none. Lives here, not in SettingsPanel, because
// the panel isn't mounted while the settings modal is closed.
watchEffect(() => {
  const id = app.model.data.sampleId;
  if (id === undefined) return;
  const label = app.model.outputs.sampleOptions?.find((o) => o.value === id)?.label;
  if (label !== undefined && label !== app.model.data.sampleLabel) {
    app.model.data.sampleLabel = label;
  }
});
</script>

<template>
  <PlBlockPage>
    <template #title>{{ BLOCK_TITLE }}</template>
    <template #append>
      <PlBtnGhost @click.stop="app.model.data.settingsOpen = true">
        Settings
        <template #append>
          <PlMaskIcon24 name="settings" />
        </template>
      </PlBtnGhost>
    </template>

    <Ab1Viewer v-if="app.model.outputs.isAb1" />
    <ReadViewer v-else />
  </PlBlockPage>

  <PlSlideModal v-model="app.model.data.settingsOpen" :shadow="true">
    <template #title>Settings</template>
    <SettingsPanel />
  </PlSlideModal>
</template>
