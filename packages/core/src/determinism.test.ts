// Phase 1 exit criteria (implementation-plan.md §4): determinism tests run
// twice-and-compare (core.md §2.2: "id and the enumeration order are
// deterministic for the same input, options, and core version").
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateVariants } from "./index.js";

const playgroundDir = fileURLToPath(
  new URL("../../../examples/playground", import.meta.url),
);

describe("generateVariants is byte-for-byte deterministic across repeated runs", () => {
  it("every examples/playground fixture produces identical variants, mapping, diagnostics, and stats twice", async () => {
    const files = (await readdir(playgroundDir)).filter((file) =>
      file.endsWith(".vue"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const filename = join(playgroundDir, file);
      const source = await readFile(filename, "utf8");
      const first = await generateVariants({ filename, source });
      const second = await generateVariants({ filename, source });
      expect(second.variants, file).toEqual(first.variants);
      expect(second.diagnostics, file).toEqual(first.diagnostics);
      expect(
        second.variants.map((v) => v.id),
        file,
      ).toEqual(first.variants.map((v) => v.id));
      // durationMs is real wall-clock time and never identical between runs;
      // every other stat must match exactly.
      expect(second.stats.decisionCount, file).toBe(first.stats.decisionCount);
      expect(second.stats.candidateCount, file).toBe(
        first.stats.candidateCount,
      );
      expect(second.stats.emittedCount, file).toBe(first.stats.emittedCount);
      expect(second.stats.uniqueHtmlCount, file).toBe(
        first.stats.uniqueHtmlCount,
      );
      expect(second.stats.warningThresholdExceeded, file).toBe(
        first.stats.warningThresholdExceeded,
      );
    }
  });
});
