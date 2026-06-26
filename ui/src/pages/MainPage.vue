<script setup lang="ts">
import { PlBlockPage, PlBtnGhost, PlMaskIcon24, PlSlideModal } from "@platforma-sdk/ui-vue";
import { useApp } from "../app";
import ReadViewer from "./ReadViewer.vue";
import SettingsPanel from "./SettingsPanel.vue";

const app = useApp();
</script>

<template>
  <PlBlockPage>
    <template #title>FASTQ Reader</template>
    <template #append>
      <PlBtnGhost @click.stop="app.model.data.settingsOpen = true">
        Settings
        <template #append>
          <PlMaskIcon24 name="settings" />
        </template>
      </PlBtnGhost>
    </template>

    <ReadViewer />
  </PlBlockPage>

  <PlSlideModal v-model="app.model.data.settingsOpen" :shadow="true">
    <template #title>Settings</template>
    <SettingsPanel />
  </PlSlideModal>
</template>
