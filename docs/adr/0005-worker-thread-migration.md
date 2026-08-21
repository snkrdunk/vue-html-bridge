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
