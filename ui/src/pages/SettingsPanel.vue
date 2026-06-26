<script setup lang="ts">
import type { SelectionMode } from "@platforma-open/milaboratories.fastq-reader.model";
import type { PlRef } from "@platforma-sdk/model";
import type { ListOption } from "@platforma-sdk/ui-vue";
import {
  PlBtnGroup,
  PlCheckbox,
  PlDropdown,
  PlDropdownRef,
  PlNumberField,
  PlTextArea,
  PlTextField,
} from "@platforma-sdk/ui-vue";
import { computed } from "vue";
import { useApp } from "../app";

const app = useApp();

const modeOptions: ListOption<SelectionMode>[] = [
  { label: "Range", value: "range" },
  { label: "Read numbers", value: "numbers" },
  { label: "Read headers", value: "headers" },
  { label: "Sequence pattern", value: "pattern" },
];

const inputOptions = computed(() => app.model.outputs.inputOptions ?? []);
const sampleOptions = computed(() => app.model.outputs.sampleOptions ?? []);

function onDatasetUpdate(ref: PlRef | undefined) {
  app.model.data.inputRef = ref;
  // Sample ids are dataset-scoped — the previous pick is meaningless for a new dataset.
  app.model.data.sampleId = undefined;
}
</script>

<template>
  <PlDropdownRef
    :model-value="app.model.data.inputRef"
    :options="inputOptions"
    label="FASTQ / FASTA dataset"
    @update:model-value="onDatasetUpdate"
  >
    <template #tooltip>Pick a sequencing dataset imported with the Samples & Data block.</template>
  </PlDropdownRef>

  <PlDropdown v-model="app.model.data.sampleId" :options="sampleOptions" label="Sample" />

  <PlBtnGroup v-model="app.model.data.selectionMode" :options="modeOptions" label="Selection" />

  <!-- Range -->
  <template v-if="app.model.data.selectionMode === 'range'">
    <PlNumberField
      v-model="app.model.data.count"
      label="Number of reads"
      :minValue="1"
      :maxValue="5000"
    />
    <PlNumberField
      v-if="!app.model.data.randomize"
      v-model="app.model.data.startFrom"
      label="Start from read #"
      :minValue="1"
    />
    <PlCheckbox v-model="app.model.data.randomize">
      Randomize — sample reads from across the file instead of sequentially
    </PlCheckbox>
  </template>

  <!-- Read numbers -->
  <PlTextField
    v-if="app.model.data.selectionMode === 'numbers'"
    v-model="app.model.data.readNumbers"
    label="Read numbers"
    :clearable="() => ''"
  >
    <template #tooltip
      >1-based read positions, separated by commas or spaces (e.g. 1, 5, 42).</template
    >
  </PlTextField>

  <!-- Read headers -->
  <PlTextArea
    v-if="app.model.data.selectionMode === 'headers'"
    v-model="app.model.data.readHeaders"
    label="Read headers"
    :rows="4"
  >
    <template #tooltip>
      One header per line (or comma-separated). Matches the read id exactly or as a prefix.
    </template>
  </PlTextArea>

  <!-- Sequence pattern -->
  <PlTextField
    v-if="app.model.data.selectionMode === 'pattern'"
    v-model="app.model.data.pattern"
    label="Sequence pattern"
    :clearable="() => ''"
  >
    <template #tooltip>Reads whose sequence contains this subsequence (case-insensitive).</template>
  </PlTextField>
</template>
