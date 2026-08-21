// Spike S4 (core.md §2, monorepo.md §14, ADR-0005): measures the longest
// uninterrupted synchronous segment of S1's parse -> resolve -> walk
// pipeline against the 100ms budget from monorepo.md §14. Reuses S1's real
// (not toy) implementation — this is deliberately NOT a separate mock
// pipeline, since a budget measured against throwaway code would not
// transfer to the real one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { collectDecisions } from "../s1-decision-model/decision-collector.js";
import { findPropsTypeArg } from "../s1-decision-model/find-props-type.js";
import { createInjectedContext } from "../s1-decision-model/type-analysis-context.js";

const BUDGET_MS = 100;

const playground = (name: string) =>
  fileURLToPath(new URL(`../../examples/playground/${name}`, import.meta.url));
const s1fixture = (name: string) =>
  fileURLToPath(
    new URL(`../s1-decision-model/fixtures/${name}`, import.meta.url),
  );

function measureOnce(filename: string): number {
  const source = readFileSync(filename, "utf-8");
  const ctx = createInjectedContext(new Map());
  const start = performance.now();
  collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
  return performance.now() - start;
}

/**
 * `collectDecisions` runs entirely synchronously today (no yield points —
 * that's Phase 1 Step 3.6's job, per implementation-plan.md). Its own
 * duration IS the longest synchronous segment for this spike's pipeline,
 * since there is nothing else in the call stack to subdivide it further.
 */
describe("S4: synchronous segment budget (core.md §2, 100ms target)", () => {
  const fixtures = [
    playground("logged-in-aria-controls.vue"),
    playground("status-literal-union.vue"),
    playground("item-list.vue"),
    s1fixture("role-badge.vue"),
    s1fixture("imported-props-shape.vue"),
  ];

  it.each(fixtures.map((f) => [f] as const))(
    "playground fixture %s stays comfortably under the 100ms budget",
    (filename) => {
      // Warm up (first call pays one-off module init/JIT cost, not
      // representative of steady-state editing) then measure.
      measureOnce(filename);
      const durations = Array.from({ length: 5 }, () => measureOnce(filename));
      const max = Math.max(...durations);
      expect(max).toBeLessThan(BUDGET_MS);
    },
  );

  it("a synthetic 60-prop / 60-v-if SFC (stress case) stays under the 100ms budget", () => {
    const filename = fileURLToPath(
      new URL(
        "../s1-decision-model/fixtures/large-synthetic.vue",
        import.meta.url,
      ),
    );
    measureOnce(filename); // warm up
    const durations = Array.from({ length: 5 }, () => measureOnce(filename));
    const max = Math.max(...durations);
    console.log(
      `large-synthetic.vue: min=${Math.min(...durations).toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );
    expect(max).toBeLessThan(BUDGET_MS);
  });

  it("records a measurement table for FINDINGS.md / ADR-0005 (not itself an assertion beyond 'runs without throwing')", () => {
    const rows = fixtures.map((filename) => {
      measureOnce(filename); // warm up
      const durations = Array.from({ length: 10 }, () => measureOnce(filename));
      durations.sort((a, b) => a - b);
      return {
        filename: filename.split("/").slice(-1)[0],
        minMs: Number(durations[0]?.toFixed(3)),
        p50Ms: Number(durations[Math.floor(durations.length / 2)]?.toFixed(3)),
        maxMs: Number(durations[durations.length - 1]?.toFixed(3)),
      };
    });
    console.table(rows);
    expect(rows.length).toBe(fixtures.length);
  });
});
