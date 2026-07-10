import { platforma } from "@platforma-open/milaboratories.fastq-reader.model";
import { defineAppV3 } from "@platforma-sdk/ui-vue";
import MainPage from "./pages/MainPage.vue";

export const sdkPlugin = defineAppV3(platforma, (app) => {
  return {
    // Standard "running analysis, no action required" overlay while the
    // extraction is computing — same as other blocks. Driven by the model's
    // isRunning output (true only during the main Run, not the pre-run).
    progress: () => app.model.outputs.isRunning,
    routes: {
      "/": () => MainPage,
    },
  };
});

export const useApp = sdkPlugin.useApp;
