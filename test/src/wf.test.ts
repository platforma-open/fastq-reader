import { platforma } from "this-block";
import { expect, test } from "vitest";

// Smoke test: the block facade + model import and instantiate cleanly.
// Full workflow integration tests need a backend and an imported FASTQ dataset
// fixture — add them with blockTest from "@platforma-sdk/test" (see
// samples-and-data/test/src/wf.test.ts for the pattern).
test("block model loads", () => {
  expect(platforma).toBeDefined();
});
