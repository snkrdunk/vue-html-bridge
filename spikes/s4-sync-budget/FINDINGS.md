# S4 findings — synchronous segment budget (feeds ADR-0005)

Real code: `measure.spike.test.ts`, timing S1's actual `collectDecisions`
pipeline (SFC parse → `compileScript` → props-domain resolution, including
cross-file type-reference walking → template compile → AST walk →
decision/domain matching) — not a separate toy benchmark. `collectDecisions`
runs entirely synchronously today (no yield points; those are Phase 1 Step
3.6's job), so its own wall-clock duration *is* the longest synchronous
segment for everything this spike exercises.

## Measurements (Node 24.14.1, this machine, 10 runs per fixture after 1 warm-up run)

| Fixture | min (ms) | p50 (ms) | max (ms) |
| --- | --- | --- | --- |
| `logged-in-aria-controls.vue` | 0.075 | 0.095 | 0.114 |
| `status-literal-union.vue` | 0.09 | 0.108 | 0.126 |
| `item-list.vue` | 0.12 | 0.179 | 0.299 |
| `role-badge.vue` (cross-file literal union) | 0.119 | 0.142 | 0.168 |
| `imported-props-shape.vue` (cross-file outer shape) | 0.064 | 0.071 | 0.093 |
| `large-synthetic.vue` (60 props, 60 `v-if`s, synthetic stress case) | 1.13 | — | 1.93 |

All measurements are **2–3 orders of magnitude under the 100ms budget**
(monorepo.md §14) — even the synthetic 60-decision stress fixture, which is
already larger than any real fixture in this repo, tops out under 2ms.

## Conclusion for ADR-0005

**Budget met on every fixture measured; no worker-thread migration needed
for Phase 0.** This is a measured conclusion from real code, not an
assumption — see the caveats below for why it isn't the final word.

## Caveats (must be re-measured, not just cited, at later gates)

1. This pipeline is S1's spike scope: prop-domain resolution + template
   walking + a subset of expression evaluation. It does **not** include
   variant *enumeration* (evaluating the whole template once per
   `VariantEnvironment` combination — core.md §3's `enumerate
   VariantEnvironment` → `evaluate whole template under each environment`
   steps), fragment serialization, or mapping-entry generation. A real SFC
   with many independent decisions could multiply this cost by the variant
   count (up to the `warnVariantCount` default of 256), which this spike
   does not model.
2. This machine's numbers aren't representative of CI runners or users'
   lower-spec machines.
3. `large-synthetic.vue` stresses *decision count* (60 boolean props) but not
   *type-resolution depth* (deep cross-file chains, large `interface`
   hierarchies, a big real-world `tsconfig.json` with many `node_modules`
   type roots) — the TypeScript-adjacent cost model in a real project could
   look different from this spike's synthetic, self-contained fixtures.

implementation-plan.md §4 (Phase 1 exit criteria) and §5 (Phase 2
measurements) already require re-measuring "the longest synchronous segment
and end-to-end latency on the real vertical slice" and "with the full
Decision Model" respectively — this spike's numbers explicitly do not
substitute for either of those gates.
