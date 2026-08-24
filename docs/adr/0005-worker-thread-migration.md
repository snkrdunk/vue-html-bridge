# ADR-0005: Worker-thread migration for core

Status: Accepted
Date: 2026-08-21

## Context

core.md §2 sets a 100ms budget for core's longest uninterrupted synchronous
segment (the delay before an `AbortSignal` can take effect is bounded by it)
and states that if measurements show this isn't good enough, core's internal
implementation can move to a worker thread without changing its already-async
public API. implementation-plan.md §3.4 (Spike S4) required measuring this on
representative fixtures (a large SFC, a large type environment) before
deciding.

The spike's real code lives in `spikes/s4-sync-budget/measure.spike.test.ts`,
timing S1's actual `collectDecisions` pipeline (`spikes/s1-decision-model/`) —
not a separate toy benchmark — against the three `examples/playground/*.vue`
fixtures, two cross-file-type-resolution fixtures, and one synthetic 60-prop
/ 60-`v-if` stress fixture. See `spikes/s4-sync-budget/FINDINGS.md` for the
full measurement table.

## Decision

**Budget met; no worker-thread migration for Phase 0 or Phase 1.** Every
fixture measured stays 2–3 orders of magnitude under the 100ms budget: the
three playground fixtures and two cross-file fixtures all complete in well
under 0.3ms, and the synthetic 60-decision stress fixture (already larger
than any real fixture in this repo) completes in under 2ms. core's
implementation proceeds as in-process synchronous code with yield points at
phase/environment boundaries (core.md §9), exactly as already designed, with
no worker-thread plumbing added.

This is a measured conclusion, not an assumption to be taken as final —
implementation-plan.md §4 (Phase 1 exit criteria) and §5 (Phase 2
measurements) already require re-measuring "the longest synchronous segment
and end-to-end latency" at each of those gates, because this spike's
pipeline is narrower than the eventual real implementation in ways that
could change the answer:

- It measures SFC parsing, props-domain resolution (including cross-file type
  references), and template-AST walking — it does **not** measure variant
  *enumeration* (evaluating the whole template once per `VariantEnvironment`
  combination, up to the `warnVariantCount` default of 256), fragment
  serialization, or mapping-entry generation, all of which are part of core's
  full pipeline (core.md §3) and could multiply the per-call cost by the
  variant count.
- The synthetic stress fixture varies decision *count*, not type-resolution
  *depth* (a real project's `tsconfig.json` with many `node_modules` type
  roots, deep cross-file `interface` hierarchies) — the TypeScript-adjacent
  cost model on a real project could differ from this spike's self-contained
  fixtures.
- Measured on one development machine; not validated against CI runners or
  lower-spec user machines.

## Consequences

1. **Design-doc update**: monorepo.md §14's Phase 0 bullet ("If the budget is
   exceeded, decide in an ADR...") is updated to state the outcome: "Phase 0
   measured the budget as met (ADR-0005); re-measured at the Phase 1 and
   Phase 2 performance gates." core.md §2's worker-thread mention stays as
   written (the public API is already async specifically to keep this
   option open) — no API change results from this ADR.
2. **Implementation task**: no new implementation task — this ADR is itself
   the "close the open question" action for monorepo.md §14's conditional.
   The re-measurement obligations already exist as implementation-plan.md §4
   and §5's performance gates; this ADR does not add to or remove from them.
3. **Verifying test**: `spikes/s4-sync-budget/measure.spike.test.ts` (7
   tests, asserting every measured fixture stays under the 100ms budget) is
   the evidence for this ADR. The Phase 1 and Phase 2 performance gates
   (implementation-plan.md §4, §5) are the tests that must re-verify this
   conclusion against the real (non-spike) pipeline before it can be relied
   upon beyond Phase 0.

## Phase 1 re-measurement (2026-08-21)

Implementation-plan.md §4's Phase 1 exit criteria required re-measuring
against the real (non-spike) pipeline. Measured on the same three
`examples/playground/*.vue` fixtures, now through the real, shipped
`vue-html-bridge` and `@vue-html-bridge/analyzer`/`@vue-html-bridge/adapter-markuplint`
implementations (Phase 1 Steps 3-5), not spike code:

- **Core's own synchronous segment** (`generateVariants` alone, 10-run
  min/p50/max): `item-list.vue` 0.28/0.43/0.72ms; `logged-in-aria-controls.vue`
  0.19/0.22/0.27ms; `status-literal-union.vue` 0.33/0.40/0.46ms — all still
  2-3 orders of magnitude under the 100ms budget, confirming Phase 0's spike
  numbers on the real implementation. Committed as a real regression test:
  `packages/core/src/performance.test.ts`.
- **Full end-to-end latency** (`analyzer.analyze()`, core + real Markuplint
  validation, 10-run min/p50/max): `item-list.vue` 16.7/17.6/21.0ms;
  `logged-in-aria-controls.vue` 10.6/11.2/11.7ms; `status-literal-union.vue`
  20.4/20.8/22.8ms. Comfortably under budget with ~5-10x headroom; the bulk
  of this time is Markuplint's own config resolution and rule execution
  inside the analyzer's bounded validation queue (a separate, already-
  abort-checked stage — analyzer.md §5.3), not part of core's uninterrupted
  synchronous segment that the 100ms figure actually bounds.

Conclusion unchanged: no worker-thread migration needed. Re-measured again,
on the full Phase 2 feature set (global Decision Model, aggregation), at the
Phase 2 performance gate (implementation-plan.md §5).

## Phase 2 re-measurement (2026-08-24)

implementation-plan.md §5's Phase 2 performance gate required re-measuring
with the full Decision Model (Track 1: templateScopeId, v-for correlation,
full directive/builtin coverage) and analyzer's normalization/aggregation/
cache (Track 2) in place, not the Phase 1 subset. Same three
`examples/playground/*.vue` fixtures, 10-run min/p50/max:

- **Core's own synchronous segment** (`generateVariants` alone):
  `item-list.vue` 0.39/0.56/9.27ms; `logged-in-aria-controls.vue`
  0.20/0.24/1.13ms; `status-literal-union.vue` 0.37/0.45/5.66ms. Materially
  unchanged from the Phase 1 numbers — the full Decision Model's extra work
  (scope tracking, `.length` safety analysis, the fuller directive table)
  does not move the needle at this scale. The occasional multi-millisecond
  max is the first sample in the run (module/JIT warmup), not a per-call
  cost; still 1-2 orders of magnitude under budget even at that outlier.
- **Full end-to-end latency** (`analyzer.analyze()`, real Markuplint
  validation, a **fresh** `WorkspaceAnalyzer` per sample so §10's
  generation/validation caches can't turn this into a cache-hit
  measurement): `item-list.vue` 21.1/23.3/120.9ms; `logged-in-aria-controls.vue`
  13.9/14.6/23.9ms; `status-literal-union.vue` 26.4/28.4/33.4ms. The one
  outlier (`item-list.vue`'s first sample, ~120ms) is Markuplint's own
  first-touch module initialization within the process, not part of core's
  bounded synchronous segment; every other sample across all three fixtures
  stays under 35ms. For comparison, a *warm* `analyzer.analyze()` call
  against an already-cached source/HTML pair (the common case in a live
  editing session, since a document is re-analyzed far more often than it's
  first opened) measured 0.02-0.05ms — the cache added in Track 2 is doing
  real, measurable work.

Conclusion unchanged: no worker-thread migration needed for Phase 2 either.
Re-measure again if/when Phase 3's external-adapter loading or a
significantly larger representative project changes the shape of this
number.

## Alternatives considered

- **Migrate to a worker thread now, preemptively**: rejected — no measured
  evidence justifies the added complexity (message-passing overhead,
  `TypeAnalysisContext.fs` needing to cross the worker boundary per core.md
  §2's own framing of what this migration would require). Revisit only if a
  later re-measurement (Phase 1/2 gates) exceeds the budget on the real
  pipeline.
- **Lower the budget target below 100ms since measured numbers are so far
  under it**: rejected — the 100ms figure is a design constraint tied to
  perceived editor responsiveness (core.md §2's cancellation-latency
  rationale), not a number to tune based on how comfortably Phase 0's narrow
  spike pipeline clears it; changing it isn't this ADR's concern and no
  evidence here suggests it should move.
