// Phase 1 exit criteria (implementation-plan.md §4): re-measure the longest
// synchronous segment on the real (non-spike) pipeline against the 100ms
// budget (core.md §2, ADR-0005). Phase 0's spike numbers do not transfer —
// this asserts against the real generateVariants implementation.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { generateVariants } from "./index.js";

const BUDGET_MS = 100;
const playgroundDir = fileURLToPath(
  new URL("../../../examples/playground", import.meta.url),
);

describe("generateVariants stays comfortably under the 100ms sync-segment budget", () => {
  it("every examples/playground fixture", async () => {
    const files = (await readdir(playgroundDir)).filter((file) =>
      file.endsWith(".vue"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const filename = join(playgroundDir, file);
      const source = await readFile(filename, "utf8");
      await generateVariants({ filename, source }); // warm up
      const start = performance.now();
      await generateVariants({ filename, source });
      const durationMs = performance.now() - start;
      expect(
        durationMs,
        `${file} took ${durationMs.toFixed(2)}ms`,
      ).toBeLessThan(BUDGET_MS);
    }
  });
});
