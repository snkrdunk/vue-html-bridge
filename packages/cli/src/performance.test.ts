// Release-build regression benchmark (implementation-plan.md §6 task 7's
// release checklist, "Phase 3 performance gate"): the full, real
// analyzer.analyze() pipeline — real Markuplint validation, no cache
// warm-up on the "cold" measurement — against every examples/playground
// fixture. This is the CLI-level counterpart to core's own
// packages/core/src/performance.test.ts (which only measures
// generateVariants' synchronous segment); this one measures what an actual
// CLI/editor invocation experiences end to end, and runs in CI (build ->
// typecheck -> test) on every push exactly like every other test here, so a
// real regression fails the build rather than silently degrading.
//
// Budgets are set well above ADR-0005's Phase 2 re-measurement numbers
// (cold: 13.9-120.9ms observed, the top end being Markuplint's one-time
// module-init cost, not a per-call cost; warm/cached: 0.02-0.05ms) — wide
// enough to absorb slower CI hardware without flaking, tight enough to
// still catch an order-of-magnitude regression.
import { readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import {
  createTypeAnalysisContext,
  createWorkspaceAnalyzer,
} from "@vue-html-bridge/analyzer";

const COLD_BUDGET_MS = 1000;
const WARM_BUDGET_MS = 50;

const playgroundDir = fileURLToPath(
  new URL("../../../examples/playground", import.meta.url),
);

describe("release-build regression benchmark: analyzer.analyze() end to end, real Markuplint", () => {
  it("every examples/playground fixture stays comfortably under budget, cold and warm", async () => {
    const files = (await readdir(playgroundDir)).filter((file) =>
      file.endsWith(".vue"),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const filename = join(playgroundDir, file);
      const source = await readFile(filename, "utf8");
      const uri = pathToFileURL(filename).toString();

      // A fresh analyzer per fixture, so the "cold" measurement can never
      // become a cache-hit measurement from an earlier fixture's run
      // (ADR-0005's Phase 2 re-measurement methodology).
      const analyzer = await createWorkspaceAnalyzer({
        workspaceRoot: playgroundDir,
        adapters: [{ adapter: markuplintAdapter, settings: {}, enabled: true }],
        typeContext: createTypeAnalysisContext(),
      });

      const coldStart = performance.now();
      await analyzer.analyze({
        uri,
        filename,
        source,
        signal: new AbortController().signal,
      });
      const coldDurationMs = performance.now() - coldStart;
      expect(
        coldDurationMs,
        `${file} (cold) took ${coldDurationMs.toFixed(2)}ms`,
      ).toBeLessThan(COLD_BUDGET_MS);

      const warmStart = performance.now();
      await analyzer.analyze({
        uri,
        filename,
        source,
        signal: new AbortController().signal,
      });
      const warmDurationMs = performance.now() - warmStart;
      expect(
        warmDurationMs,
        `${file} (warm/cached) took ${warmDurationMs.toFixed(2)}ms`,
      ).toBeLessThan(WARM_BUDGET_MS);

      await analyzer.dispose();
    }
  });
});

// plan.md T7 / TC-REQ8-C: collectVariantArtifacts must be a true no-op when
// left at its default (omitted) — the same cold/warm budgets above must
// still hold for at least one representative fixture with the option
// explicitly false, proving REQ-8 ("no cache/perf cost for the default
// run") isn't just incidentally true because no test happens to pass the
// option.
describe("release-build regression benchmark: collectVariantArtifacts omitted stays within budget (REQ-8/TC-REQ8-C)", () => {
  it("a representative fixture stays within the same cold/warm budgets with collectVariantArtifacts: false", async () => {
    const [file] = (await readdir(playgroundDir)).filter((f) =>
      f.endsWith(".vue"),
    );
    if (file === undefined) throw new Error("no playground fixtures found");
    const filename = join(playgroundDir, file);
    const source = await readFile(filename, "utf8");
    const uri = pathToFileURL(filename).toString();

    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: playgroundDir,
      adapters: [{ adapter: markuplintAdapter, settings: {}, enabled: true }],
      typeContext: createTypeAnalysisContext(),
      collectVariantArtifacts: false,
    });

    const coldStart = performance.now();
    const coldResult = await analyzer.analyze({
      uri,
      filename,
      source,
      signal: new AbortController().signal,
    });
    const coldDurationMs = performance.now() - coldStart;
    expect(
      coldDurationMs,
      `${file} (cold) took ${coldDurationMs.toFixed(2)}ms`,
    ).toBeLessThan(COLD_BUDGET_MS);
    expect(coldResult.variantArtifacts).toBeUndefined();

    const warmStart = performance.now();
    const warmResult = await analyzer.analyze({
      uri,
      filename,
      source,
      signal: new AbortController().signal,
    });
    const warmDurationMs = performance.now() - warmStart;
    expect(
      warmDurationMs,
      `${file} (warm/cached) took ${warmDurationMs.toFixed(2)}ms`,
    ).toBeLessThan(WARM_BUDGET_MS);
    expect(warmResult.variantArtifacts).toBeUndefined();

    await analyzer.dispose();
  });
});
