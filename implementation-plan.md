# vue-html-bridge Implementation Plan

Status: Proposed
Last updated: 2026-08-20
Sources: `docs/design/README.md`, `docs/design/monorepo.md`, `docs/design/packages/*.md`, `docs/design/decision-changes.md`

This plan turns the design documents into an ordered, verifiable sequence of work. Phase numbering follows monorepo.md §14. Where this plan and a design document disagree, the design document wins; update the design document first, then this plan.

Phase 1 and Phase 2 are internal milestones and are **not published to npm**. The initial release is the completion of Phase 3.

---

## 1. Guiding constraints (recap)

These come from monorepo.md §3 and shape every task below:

- core knows nothing about validators; adapters know nothing about Vue; analyzer knows nothing about LSP; only language-server touches LSP types.
- All internal coordinates are UTF-16 absolute offsets with half-open ranges.
- Same input → same variant IDs, order, and diagnostics (determinism is a test gate, not an aspiration).
- Failures are isolated per adapter; cancellation is mandatory and never becomes a diagnostic.
- No implicit loading of arbitrary code; external adapters require explicit configuration and trust.

---

## 2. Stage A: Repository scaffolding (before Phase 0)

Goal: an empty but fully wired monorepo where every later PR lands with CI, types, and tests already enforced.

| #   | Task                                                                                                                                                                                                                               | Notes                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `git` hygiene: commit the design docs; pin the Rev. 8 comparison base of `decision-changes.md` by commit hash                                                                                                                      | decision-changes.md notes this explicitly                                                                                                                |
| A2  | pnpm workspace: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`                                                                                                                                                   | Layout per monorepo.md §4.2                                                                                                                              |
| A3  | Package skeletons for `core`, `validator-api`, `analyzer`, `adapter-markuplint`, `language-server`, `settings`, `cli`, `adapter-testkit` with correct names, `"type": "module"`, internal `workspace:*` deps matching §4.1 exactly | Enforce "no cycles / core depends on nothing internal / nothing depends on cli" with a dependency-lint check (e.g. a script or dependency-cruiser) in CI |
| A4  | Test runner (Vitest), TypeScript strict config, lint/format                                                                                                                                                                        | ESM-first because Markuplint is ESM (adapter-markuplint §3.2)                                                                                            |
| A5  | CI: typecheck + test on a Node version matrix; placeholder for the Markuplint version matrix                                                                                                                                       | Matrix values fixed after the Phase 0 spike pins versions                                                                                                |
| A6  | Package build pipeline: per-package `exports` / `types` / `bin` maps, declaration output, `pnpm -r build`, ESM cross-import check between workspace packages                                                                       | Tooling per ADR-0001; publish-side verification (pack/install smoke test) is a Phase 3 task                                                              |
| A7  | `docs/adr/` directory + ADR template; ADR-0001 records the build/release tooling decision (Changesets is the candidate per monorepo.md §4.2)                                                                                       | Every "open question" in the design docs resolves into an ADR here                                                                                       |
| A8  | `examples/playground/` stub with 2–3 fixture `.vue` files used by spikes and later E2E                                                                                                                                             | Include the §13.3 language-server fixture (`loggedIn` / `aria-controls`)                                                                                 |

Exit criteria: `pnpm install && pnpm -r build && pnpm -r test` passes on CI with empty packages; dependency-direction lint active.

---

## 3. Phase 0: Types and technical spikes

Goal: retire the highest-risk unknowns with running code, and produce the two artifacts that gate Phase 1 (the rule manifest and the pinned Markuplint API usage). Spike code lives outside `src/` (e.g. `spikes/`) and is not shipped.

### 3.1 Spike S1 — Decision Model feasibility (core)

Confirm we can build a Decision Model from the Vue compiler AST plus TypeScript type analysis (monorepo.md §14).

- Parse an SFC, walk the template AST, resolve a binding's TypeScript symbol + access path, and derive a finite domain for `boolean` and literal unions.
- Prototype `TypeAnalysisContext` both ways — core-owned project service vs. caller-injected — and decide ownership (core.md §2). **ADR-0002.**
- ADR-0002 is a decision plus design work, not a decision alone. Before Phase 1 starts, its outcome must be reflected into the design APIs: where the TypeScript project service is created, shared, and disposed; how unsaved SFC script content enters the type environment; how the "TypeScript project epoch" (analyzer.md §10.1) is generated and bumped (tsconfig changes, imported type definitions, other-file changes); and — if caller-injected wins — the `TypeAnalysisContext` plumbing added to analyzer (`CreateWorkspaceAnalyzerOptions` / `AnalyzeRequest`) and the language server. Today no analyzer API carries a type context while core's cache key already demands a project epoch; that gap is closed here, in the design docs.
- Produce the complete expression-grammar → evaluator table as a fixture, finalizing core.md §4.6 ("will be fixed as a Phase 0 spike fixture").

### 3.2 Spike S2 — Markuplint in-memory API (adapter-markuplint §3.1)

Acceptance criteria 1–7 verbatim from the design doc:

1. Validate an HTML string without touching the filesystem, under an arbitrary `.html` virtual filename.
2. `extends` / plugins / `rules` / `nodeRules` resolve from an explicit config file.
3. Vue parser mappings in config do not apply to the virtual `.html`.
4. Pin down the unit/base/end semantics of violation line/col/raw (drives the UTF-16 converter).
5. Measure engine/file reuse across calls and concurrency safety → decides `maxConcurrentValidations` (currently a conservative 1).
6. **Fix the generated-html profile rule manifest v1** against the target Markuplint major version — this is a hard gate for Phase 1 (adapter-markuplint §5, monorepo.md §14).
7. Record the config-search filename list of the target Markuplint version as a source-controlled fixture; `configFilePatterns` is asserted against it, so search-target drift on a version update fails a test instead of being tracked by hand (adapter-markuplint §3.1 item 7, §9.2 item 14).

If criterion 1 fails, design the temp-file fallback (safe temp dir, collision-free names, `finally` cleanup) before proceeding — under the condition that it preserves the meaning of the public path contract: config discovery still keys off `sourceFilename`, `overrides` / `parser` / `excludeFiles` matching is still evaluated against the contractual `virtualFilename` (validator-api §3.2), and the real temp path is used only for content loading. If those cannot be separated, that is a design change to escalate, not a fallback. Pin the Markuplint version and record it in peer deps + CI matrix. **ADR-0003** (API usage + version policy).

### 3.3 Spike S3 — UTF-16 round trip and client matrix (language-server §5)

- Round-trip fixtures: offset ↔ Position across CRLF, emoji, combining marks, zero-width ranges.
- Survey the target LSP client matrix for `positionEncodings` support; settle the initial scope for non-UTF-16 clients. **ADR-0004.**

### 3.4 Spike S4 — Synchronous segment budget (core.md §2, monorepo.md §14)

- Measure core's longest synchronous segment on representative fixtures (large SFC, large type environment) against the 100 ms budget.
- If exceeded: **ADR-0005** decides worker-thread migration and how `TypeAnalysisContext` crosses the worker boundary. The public API is already async, so this does not change callers.

### 3.5 Phase 0 exit criteria

- ADR-0002…0005 merged (0005 may conclude "budget met, no worker needed"), each closed with the §8 decision follow-through (design-doc update, assigned implementation task, verifying test). For ADR-0002 specifically: core.md / analyzer.md / language-server.md updated with the project-service lifecycle, unsaved-buffer handling, epoch definition, and the context-passing API; the Phase 1 steps below assume those updated APIs.
- Rule manifest v1 committed and reviewed as product behavior, not an implementation detail.
- Expression evaluation table fixture committed; core.md §4.6 updated to match.
- Markuplint version pinned; CI matrix updated; config-search filename fixture committed (S2 criterion 7).
- Open questions listed for "Phase 0" in monorepo.md §15 and package docs answered (project-service ownership, config-override filename semantics, position-encoding scope).

---

## 4. Phase 1: Vertical slice (internal milestone)

Goal: one `.vue` fixture flows from an LSP request to published Markuplint diagnostics. Scope limits (monorepo.md §14): single-expression `boolean` / literal-union expansion with **no cross-expression correlation**, `v-for` renders one exemplar, provenance limited to `source-literal` / `sentinel`. Contradictory variants from independent expansion are accepted for now and must not leak into any public/external description.

Implementation order is dependency-driven. Each step lands with its package's relevant numbered tests from the design doc.

### Step 1 — `@vue-html-bridge/validator-api` v1

No internal dependencies; everything else builds on it.

- All SPI types needed by the vertical slice (validator-api §3): adapter/capabilities/session/request/result/failure, `AdapterSessionFailure`, `GeneratedRange`, `JsonValue`, logger. The optional `ConfigWatchTarget` / `getConfigWatchTargets()` extension in the final v1 design is deliberately implemented and exercised in Phase 3 task 2, before the first publication and before external adapters are enabled.
- `runtime-check.ts`: minimal runtime shape validation of an unknown adapter export (§10). No dynamic import.
- The `virtualFilename` format (`…/<source>.__vue_html_bridge__/variant-<content-hash>.html`) documented as normative (§3.2).
- Tests: type-level API surface, JSON-serializability of result types, runtime-check accepts/rejects fixtures.

### Step 2 — `@vue-html-bridge/adapter-testkit` (minimal)

Needed before the Markuplint adapter and analyzer so they are tested against the contract from day one.

- Framework-neutral `createAdapterContractCases` + Vitest binding (testkit §2).
- Contract cases required in Phase 1: valid/invalid HTML (§3.1), UTF-16/multiline (§3.2), no-range (§3.3), severity mapping / ordering / determinism / metadata purity (§3.4 — required by the cross-cutting determinism gate), failure separation incl. `AdapterSessionFailure` shape (§3.5), cancellation (§3.6), lifecycle (§3.7), JSON serializability (§3.9).
- Fake adapter with call capture / enqueue / barrier (§4) — required by analyzer tests.
- Defer to Phase 3: §3.8 (concurrency deep-equal, wrapped-mode range correction, request non-mutation, metadata runtime shape), sample adapter polish, and the full broken-adapter self-test suite (keep a seed of it now: one wrong-offset adapter proves the suite can fail). The Markuplint adapter re-runs the completed full suite as a Phase 3 release gate.

### Step 3 — `vue-html-bridge` (core, minimal)

The largest step; split into PR-sized slices in this order:

1. **SFC parsing + input contract** (core.md §1 table): template extraction, diagnostics for pug/`src`/script variations.
2. **Fragment IR + serializer** (§6): one-line contract, escaping (`&#10;` in attribute values, text newline → space), void elements, casing/namespaces, deterministic attribute order. Golden tests first — the serializer contract is what every downstream range depends on.
3. **Mapping** (§7): `MappingEntry` emission during serialization, ordering rules, `findSourceOrigins` including zero-width point-query rules (§7.2). Two-sided slice assertions (`html.slice` and `source.slice`).
4. **TypeScript project context** (per ADR-0002's updated design): project service creation/sharing/disposal in its decided owner; unsaved SFC script content reflected into the type environment; the symbol/access-path/type resolution used by slice 5. Tests: imported type definitions resolve, unsaved script content is honored, and a tsconfig change is picked up by a subsequent analysis. The epoch-keyed cache-invalidation half lands with the Phase 2 caches (Track 2).
5. **Per-node decisions** (Phase-1 shape): boolean / literal-union domains for `v-if` and `v-bind`, independent per node; `v-for` single exemplar; dummy/sentinel values with the form-value table (§5.4); `v-html` exclusion and comment stripping. `v-on` / `v-model` are **not** in Phase 1: they emit `synthetic` provenance, which the Phase 1 scope excludes — they move to Phase 2 Track 1 together with the normalization that consumes them. The Phase-1 directive set is exactly what the E2E fixture needs.
6. **Async pipeline shell** (§2, §9): `generateVariants` returning a Promise; `signal.throwIfAborted()` before every environment; a **macrotask** yield (`setImmediate`-class) on an elapsed-time budget rather than per environment — a bare `await Promise.resolve()` never reaches the I/O phase, so `didChange` would stay unobservable, while yielding on every environment is too slow; fix the interval by benchmark. `AbortError` on cancel, never a partial result, stats (`decisionCount`…`warningThresholdExceeded`), `warnVariantCount` warning, `customElements` matching.

- Tests from core.md §10 achievable now: 3 (branch exclusivity is a property of a single IF node's branch decision — no cross-expression correlation needed), 4 (the literal-union/nullish/general-string subset), 7 (the component/slot/`v-html` exclusion half), 8–15, 17 (15 ships here because slice 3 implements the zero-width rules). Tests 1–2, 5, 16, the unevaluable-expression half of 4, and the custom-directive half of 7 belong to Phase 2 features; add them then.

### Step 4 — `@vue-html-bridge/adapter-markuplint`

Built directly on the Phase 0 spike results.

- **Session creation**: settings validation and shared-resource initialization only. An explicit `settings.configFile` is the one thing resolvable here (from `workspaceRoot`); if it is missing or fails to parse, reject with `AdapterSessionFailure`.
- **Per-validate config resolution**: `sourceFilename` arrives only on `ValidateHtmlRequest` (validator-api §3.2), and different SFCs in one workspace can resolve different nearest configs — so upward config search runs inside `validate`, cached per source directory / resolved-config identity within the session; the resolved path is passed explicitly with `noSearchConfig: true` (§4). Discovery/parse failures at this stage are returned as `configuration-error` in `ValidateHtmlResult.failures`, not thrown. Update adapter-markuplint.md §4 to state this timing explicitly.
- In-memory validation via the pinned MLEngine usage; violation → `GeneratedDiagnostic` conversion with the UTF-16 location index (§6).
- generated-html profile overlay from the manifest + `profileRuleOverrides` priority chain (§5); `applicability` classification map.
- `exec()` null-result disambiguation (§6.3); failure table (§7).
- Tests: the testkit contract cases available in Phase 1 (Step 2) + the Markuplint-specific fixtures on the vertical-slice critical path: §9.2 items 1, 3, 5–11, 14 (the `configFilePatterns` drift test against the Phase 0 fixture), session dispose, and a new fixture — two SFCs in nested directories resolving different Markuplint configs. Items 2 and 4 (full `extends`/plugin matrix, synthetic-path override) move to Phase 2; item 12's reconfigure half moves with Track 2; item 13 (version matrix) is Phase 3. Golden tests split structural vs. message assertions (§9.3).

### Step 5 — `@vue-html-bridge/analyzer` (single-adapter path)

- `createWorkspaceAnalyzer` / `analyze` pipeline (§4): run core once, build work items with HTML-hash dedup within an adapter (§5.1), `virtualFilename` derivation (§5.2), bounded concurrency respecting `maxConcurrentValidations` (§5.3).
- Thread the type context per ADR-0002's updated design: whatever `TypeAnalysisContext` / project-epoch plumbing the design defines (`CreateWorkspaceAnalyzerOptions` or `AnalyzeRequest`) is implemented here so core receives it on every generate call.
- Reverse mapping with priority order and fallbacks (§6); merge core diagnostics + adapter failures with the `adapter/<id>/<code>` convention (§9).
- Defer to Phase 2: provenance rewrite/suppression (§7), two-stage aggregation (§8) — in Phase 1, one occurrence maps to one source diagnostic; caching (§10); `reconfigure` beyond a trivial full-rebuild.
- Tests from analyzer.md §12 achievable now: 1–4 (3: the static/dynamic half — the synthetic half lands in Phase 2), 10–12 (12: no-new-work-after-abort and no leftover result — the no-leftover-cache half lands with Phase 2 caches), 15–16 (virtual filename determinism). The rest land with their Phase 2 features.

### Step 6 — `@vue-html-bridge/language-server` (minimal)

- stdio server, initialize/capabilities, UTF-16 position encoding only (per ADR-0004 scope), incremental sync.
- didOpen/didChange → analyze → `publishDiagnostics` with version gating in its simplest correct form (§6.5 snapshot/controller pattern — implement it fully now; it is cheap and prevents the worst class of bugs).
- SourceDiagnostic → LSP Diagnostic conversion (§7.1), deterministic publish order.
- Defer to Phase 2: debounce tuning, hover, settings schema/decomposition, config watching, multi-root, trust/external adapters (built-in Markuplint only, hardcoded default settings acceptable inside the internal milestone).

### Step 7 — Vertical-slice E2E

- In-memory JSON-RPC harness (language-server §13.2 items 1–3, 6) + the E2E fixture (§13.3).
- monorepo.md §12.2 Phase-1 items: UTF-16 correctness with emoji + attribute-value newline; core diagnostics still published when Markuplint fails.
- Cancellation integration test: send `didChange` over JSON-RPC while generation is in flight and assert the previous analysis actually aborts promptly — this validates the yield strategy end to end, not just the `AbortSignal` wiring.

### Phase 1 exit criteria

- The E2E above passes in CI, including the mid-generation cancellation test.
- Every package's Phase-1-scoped numbered tests pass; determinism tests run twice-and-compare in CI.
- Performance gate: re-measure the longest synchronous segment and end-to-end latency on the real vertical slice (Phase 0's numbers came from spike code); record against the 100 ms budget.
- Decisions recorded — each with the §8 follow-through (design-doc update + assigned implementation task + verifying test) — for "runtime schema validation of adapter settings: language server or analyzer" (analyzer.md §13; implementation lands in Phase 2 Track 4 and must ship before Phase 3 exposes external adapters) and "excludeFiles silent-ignore vs. info diagnostic" (adapter-markuplint §10; implementation lands in Phase 2).

---

## 5. Phase 2: Editing experience and robustness

Goal: the design's actual semantic core (correlation, aggregation, provenance) plus the editor-quality behaviors. Work is grouped in five tracks that can proceed largely in parallel after Track 1's model lands.

### Track 1 — core: global Decision Model

1. Decision identity (symbol + access path + `templateScopeId`) and shared `VariantEnvironment` (§4.1–4.2).
2. Expression evaluation per the §4.6 table: supported operator subset, `EvaluationResult`, predicate decisions with negation-only correlation, unified unknown-fallback rules, model-build-time diagnostic dedup by `code + sourceRange`.
3. `v-for` 0/1/2 with collection-cardinality decisions correlated with interpretable `length` predicates; conservative fallback for `> 2` style predicates and non-identity collections (§4.5).
4. Full directives table (§5.3), including `v-on` → `onclick="dummy-fn"` and `v-model` element-specific output (moved here from Phase 1 because they emit `synthetic` provenance), `v-bind` modifiers, conflict rules; Vue builtins: Transition/Teleport/TransitionGroup/Suspense, `v-slot` recognition order (§5.2); custom-directive removal diagnostics.
5. Full provenance set: add `finite-domain` and `synthetic` (§5.4).

- Completes core.md §10 tests 1–3, 5, 6, 7, 15, 16 (3 and 15 already shipped in Phase 1; the Phase 2 halves of 4 and 7 land here).

### Track 2 — analyzer: normalization, aggregation, cache, reconfigure

1. Provenance-based normalization (§7): sentinel rewrite to `vue-html-bridge/non-finite-attribute-value` with identity rules (§7.1), synthetic suppression only for `applicability: "source-representation"` (§7.2), `document-context` never suppressed.
2. Two-stage aggregation (§8): occurrenceKey / sourceKey exactly as specified; severity-max; prefer-duplicates-over-wrong-merge; relatedInformation cap 8; evidence truncation at 5. Implement it as a streaming accumulator — remap → normalize → `accumulator.add` per (member variant × diagnostic) — so memory never scales with a materialized `variant × diagnostic` occurrence array; the accumulator holds counts plus evidence only up to its caps, which matches the evidence-bound spec by construction (analyzer.md §4's staged pipeline remains as the type-level structure).
3. Caches (§10): core result cache keyed with the ADR-0002 project epoch (the tsconfig/dependency epoch-bump wiring and its invalidation tests land here); session-scoped adapter validation cache; LRU bounded by entry count and approximate bytes with a defined eviction policy; nothing cached on abort/failure. Fix the key-normalization/hash spec in one module: stable sorted-key JSON canonicalization, one hash algorithm (e.g. SHA-256) with a path-safe encoding for the virtual-filename segment, no value re-comparison on hash hits (a documented reliance on the hash), Windows path/case normalization for `sourceFilename`. Reconcile the "adapter version" component of the §10.2 key: the SPI exposes no version field and the cache dies with its session, so session generation subsumes it — update analyzer.md, or add an optional SPI version field, and record which.
4. `reconfigure` (§11): settings-hash diff + `invalidateAdapters` forced recreation; atomic session swap; dispose-after-drain. This is the only route for config-file content changes — wire it before Track 4's watcher.

- Completes analyzer.md §12 tests 5–9, 12–14, 17 (plus the Phase 2 halves of 3 and 12). ADR for the transformation-group-ID field on `MappingEntry` (§13) when aggregation is implemented.

### Track 3 — language server: interaction quality

1. Debounce (default 200 ms), abort-previous, didSave/didClose behaviors (§6).
2. Hover: cached per URI/version, hit-testing rules, sentinel-first presentation, "Validator detail" = one representative + count, message-length measurement hooks (§8).
3. Session-level failure dedup per workspace using the `adapter/<id>/…` code convention (§7.3).
4. Shutdown/exit lifecycle (§12): stop scheduling, cancel all timers and AbortControllers, dispose all workspace analyzers, exit-code convention, best-effort dispose on process signals — this is the implementation behind protocol test 10.
5. Non-UTF-16 position converters (UTF-8/UTF-32), if and only if ADR-0004 put them in scope; unit test 1 grows to cover them.

- Completes language-server §13.1 items 1–3 and §13.2 items 4–5, 7, 10.

### Track 4 — settings, config watching, multi-root, trust

1. Settings foundation: create **`@vue-html-bridge/settings`** (settings.md) — the input/resolved type split, the §3.1 defaults-and-constraints table (including the delegated-`undefined` representation and the default `validators` entry), `resolveSettings` with its per-layer validation → pin-to-default → merge order, `decomposeSettings`, the discovery and explicit-file loaders with distinguished failure kinds, and the `schema.json` golden published at `@vue-html-bridge/settings/schema.json` — and wire the language server to it (language-server.md §9.2, continue-with-fallback). Runtime validation of `validators[].settings` per the Phase 1 decision (must be in place before Phase 3 exposes external adapters). Settings must drive behavior, not merely parse: explicit tasks and tests for `enabled`, `include`/`exclude` document filtering, and the `validateOnChange` / `validateOnSave` scheduling gates. Building the schema in the shared package now is what lets the Phase 3 CLI reuse it unchanged.
2. Config watching (§9.3) registers the bridge settings files (`.vue-html-bridge.json` / `package.json`) and each enabled adapter's `configFilePatterns`, routing a match to settings reload or `reconfigure({ invalidateAdapters: [id] })` as appropriate. During the unpublished Phase 2 milestone only, the built-in Markuplint adapter's explicit `settings.configFile` may be registered by its known schema; the language server must not generalize this into inspecting `validators[].settings.configFile` for every adapter. The validator-independent concrete-target SPI replaces that temporary built-in path before external adapters ship in Phase 3. Implement analyzer.md §2's `ReconfigureOptions.maxConcurrency` so a `workspace/didChangeConfiguration` can resize the live queue without recreating adapter sessions or discarding unrelated caches.
3. Multi-root: per-folder analyzer/session/cache, longest-prefix routing, single-file restricted session (§9.1); explicit tasks and tests for `didChangeWorkspaceFolders` — create sessions for added folders, abort and dispose for removed ones.
4. Untrusted workspace: built-in Markuplint with bundled safe defaults, forced `searchConfig: false`, one notice per workspace; no external adapters (§4.2). External-adapter loading itself is Phase 3.

- Tests: a watch-event matrix — bridge settings file change → settings reload; built-in Markuplint explicit config change → its forced session recreation; a `configFilePatterns` match → forced recreation; each case followed by re-analysis of open documents. Completes language-server §13.1 items 4–5 and §13.2 items 8–9. The same behavior for arbitrary external adapters is the Phase 3 SPI gate.

### Track 5 — adapter-markuplint hardening

1. Complete the config-resolution coverage deferred from Phase 1: Markuplint-specific fixture 2 (`extends` / plugins / `rules` / `nodeRules`) and fixture 4 (synthetic-path override/parser/exclude matching).
2. Implement the Phase 1 decision for `excludeFiles` (silent ignore or info diagnostic), update adapter-markuplint.md, and add the verifying fixture required by the decision follow-through rule.
3. Complete fixture 12's reconfigure half: a config change forces session recreation, the old session drains and disposes, and the session-scoped validation cache is discarded without affecting other adapters.
4. Keep config/dependency resolution data in a form that Phase 3's `getConfigWatchTargets()` implementation can expose without re-resolving configs or teaching the language server about Markuplint settings.

### Phase 2 measurements (feed later ADRs)

The measurement harness is an internal, unpublished CLI runner — a thin analyzer consumer and the precursor of `@vue-html-bridge/cli` (monorepo.md §14). Besides the per-SFC metrics below, run it at representative workspace scale (hundreds of `.vue` files) and record wall time, peak memory, and total NDJSON output size — these numbers decide the CLI's file-level-concurrency open question (cli.md §10; output format itself is already settled as NDJSON, product decision 2026-08-21). Collect on real projects: variant counts vs. the 256 warning default; aggregated diagnostic counts (display-cap decision); hover message lengths; analysis latency (pull-diagnostics decision); adapter cache hit rates (`getConfigFingerprint` SPI extension); config-parse-error grace behavior. Concrete config dependencies are no longer an open measurement-driven SPI question: Phase 3 exposes them as config watch targets. Performance gate (Phase 0's spike numbers do not transfer): re-measure the longest synchronous segment and end-to-end latency with the full Decision Model, plus peak heap and per-variant memory, on representative projects.

### Phase 2 exit criteria

- All monorepo.md §12.2 E2E items pass, including the Phase-2-annotated ones (correlation, v-for 0/1/2, cross-variant single diagnostic, related information, stale-result suppression).
- Every numbered core/analyzer/language-server test assigned through Phase 2 passes, together with the Markuplint fixtures assigned to Track 5 and the settings-package tests (settings.md §8). Tests explicitly assigned to Phase 3 in the traceability appendix are not part of this internal milestone's gate.
- Measurement report committed, including the Phase 2 performance gate results; ADR backlog updated with data.

---

## 6. Phase 3: Adapter SDK and initial release

Goal: everything needed for third parties, then the first npm publish of all production packages.

1. **adapter-testkit completion**: full contract suite incl. concurrency deep-equal, wrapped-mode range correction, request non-mutation, metadata runtime shape (§3.8); complete broken-adapter self-tests (§6); sample `no-blink` adapter (§5); export split `.` / `./fake` / `./vitest` (§9); testkit versioning policy (§7).
2. **Concrete config-watch-target SPI** (must complete before external adapter loading): add validator-api's `ConfigWatchTarget` and optional session `getConfigWatchTargets()` snapshot; have analyzer shape-validate, tag, sort/deduplicate, and expose the union through `WorkspaceAnalyzer.getConfigWatchTargets()`; have the language server diff registrations after session changes and analyses without inspecting adapter-specific settings. `configFilePatterns` remains for not-yet-existing/newly-nearer configs. Markuplint reports explicit/discovered configs plus resolvable `extends`/plugin files. Complete analyzer test 18, language-server unit test 7 and protocol test 11, Markuplint fixture 15, and adapter-testkit §3.10 including a broken-target self-test.
3. **Shared adapter loading + trust**: implement **`@vue-html-bridge/adapter-loader`** (adapter-loader.md) — built-in injection, the specifier/trust/runtime-shape/`apiVersion` gates, structured deduplicated failures — with its gate-matrix tests, then have both hosts consume it: the language server converts failures to deduped notices and retries on configuration change (language-server §10.2); the CLI converts them to stderr + run-level errors (cli.md §8). A shared contract fixture runs against both hosts so the gating is observably identical, instead of two separate implementations of "the same" rules. Verify that an external adapter's concrete watch targets trigger only that adapter's session recreation. ADRs: package specifier/PnP support; sandboxing feasibility conclusion (monorepo.md §15).
4. **validator-api compatibility documentation** (§8): apiVersion/semver policy, adapter peer-dep guidance, including the optional config-watch-target method.
5. **`@vue-html-bridge/cli`**: grow the Phase 2 internal runner into the published CLI (cli.md) — the full §4.2 flag surface with settings parity (via `resolveSettings` / `loadSettingsFile`), per-adapter validator flags with the entry-key and dotted-path grammar incl. prototype-pollution resistance, file enumeration with the workspace boundary and realpath dedup, `pathToFileURL`-based URIs, the run outcome model (run-level errors reported once, failure-isolated continuation, exit precedence, SIGINT 130 / SIGTERM 143), the normative `CliJsonOutputV1` with goldens for success, exit-2, and interrupted runs, and trust behavior (invocation-trusted default; `--untrusted` forcing only trust-sensitive settings). Gates: the CLI/LSP parity E2E with equalized trust and resolved settings, plus the restricted-mode parity run (cli.md §9 item 14; monorepo.md §12.2).
6. **Release engineering**: Changesets (per ADR-0001) with independent versions; `schema.json` published as the canonical `@vue-html-bridge/settings/schema.json` export, with the language-server copy kept as a backward-compatibility alias (settings.md §7); README/usage docs per package; license/provenance checks; the client-launcher decision (language-server §14, "decided at Phase 3's initial release"). Publish verification for every public package, not just the adapter path: `pnpm pack` each package, install the tarballs into an out-of-repo smoke project, import and run them — for language-server, launch `dist/bin.js --stdio` and complete an initialize handshake; for the CLI, run `vue-html-bridge` against a fixture workspace, check its output and exit code, and verify the `$schema` reference `./node_modules/@vue-html-bridge/settings/schema.json` resolves in a CLI-only project (no language-server dependency).
7. **Release checklist**: cross-package coordinate-contract review (monorepo.md §13); the Markuplint adapter passes the finalized full testkit suite (release gate); the CLI/LSP parity E2E passes; a release-build regression benchmark added to CI (Phase 3 performance gate); docs/design Status flipped from Proposed as appropriate; decision-changes.md finalized.

Exit criteria: all packages published; a third-party adapter can be built against published validator-api + adapter-testkit alone (verify by building the sample adapter in an out-of-repo smoke project).

---

## 7. Phase 4: Second-adapter validation

Goal: prove the SPI with a validator that is architecturally unlike Markuplint.

1. Prototype `@vue-html-bridge/adapter-vnu`: subprocess/service execution, `fragmentHandling: "wrapped"` with wrapper-diagnostic exclusion and range correction, native cancellation if available.
2. Run it through the full testkit suite unmodified; any needed change to testkit/validator-api/analyzer is a design finding, not a local patch.
3. Confirm no Markuplint-specific assumptions leaked into validator-api/analyzer (analyzer.md §13's wrapped-contract question resolves here).
4. Fold findings into validator-api v1.x or a planned v2 list.

---

## 8. Cross-cutting workstreams (all phases)

- **Determinism gate**: CI job that runs generation/analysis twice on fixtures and diffs results byte-for-byte.
- **Decision follow-through**: every ADR or recorded decision closes with three artifacts — (1) the design-doc update, (2) an implementation task added to or assigned within this plan, (3) a test verifying the decided behavior. A decision without all three is not done. This applies to the Phase 0/1 decisions explicitly: `TypeAnalysisContext` ownership, position-encoding scope, adapter-settings runtime validation, and `excludeFiles` handling.
- **CI matrix**: Node LTS versions × pinned Markuplint version(s); grows to a Markuplint major matrix when a second major is supported (adapter-markuplint §9.2 item 13).
- **Docs discipline**: each merged ADR updates the corresponding design doc section and strikes the item from the open-questions lists. This plan's checkboxes are tracked in PR descriptions, not duplicated elsewhere.
- **Privacy/logging rules** (language-server §11, validator-api §3.4): enforced by lint where possible (no `console.*` in adapters, no stdout logging in the server).

---

## 9. Risk register

| Risk                                                                                                                                               | Phase | Impact | Mitigation / trigger                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript symbol/type resolution is the hardest part of core; the spike may show it is slow or brittle                                            | 0–2   | High   | S1 spike first; `TypeAnalysisContext` abstraction keeps ownership swappable; worker-thread ADR path already designed                                |
| Markuplint has no reliable in-memory API for a virtual filename                                                                                    | 0     | High   | S2 criterion 1; designed temp-file fallback confined to the adapter, valid only if it preserves the `virtualFilename` contract (§3.2)               |
| Sync segment exceeds the 100 ms budget on large SFCs                                                                                               | 0     | Medium | S4 measurement; async API already shields callers from a worker migration; re-measured at the Phase 1 and Phase 2 performance gates                 |
| Variant explosion in real projects despite the warn-only threshold                                                                                 | 2     | Medium | Stats + warning ship in Phase 1; hard limit/sampling/constraint-solving ADR only if measurements demand it (monorepo.md §10.1)                      |
| MLEngine not concurrency-safe → throughput bound by `maxConcurrentValidations: 1`                                                                  | 1–2   | Medium | S2 criterion 5; HTML-hash dedup and session cache reduce call volume first                                                                          |
| Non-UTF-16-only LSP clients                                                                                                                        | 0     | Low    | ADR-0004 fixes scope early; never claim unsupported encodings                                                                                       |
| Contradictory Phase-1 variants confuse internal testers                                                                                            | 1     | Low    | Internal milestone only; limitation documented in fixtures and PR descriptions, absent from any external spec                                       |
| Workspace-scale CLI runs (hundreds of files) stress wall time, peak memory, and NDJSON output size in ways single-SFC LSP profiling never measures | 2–3   | Medium | Phase 2 internal-runner measurements at workspace scale; file-level concurrency stays a deferred decision driven by that data (cli.md §10) |

---

## 10. ADR backlog (consolidated from the design docs)

| ADR  | Topic                                                                                                                                                                                                                                                                                                                                                                                                                              | Decide in                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0001 | Build/release tooling (Changesets)                                                                                                                                                                                                                                                                                                                                                                                                 | Stage A                                                                    |
| 0002 | `TypeAnalysisContext` ownership (core-owned vs. injected project service)                                                                                                                                                                                                                                                                                                                                                          | Phase 0 (S1)                                                               |
| 0003 | Markuplint API usage, version pin, config-override filename semantics                                                                                                                                                                                                                                                                                                                                                              | Phase 0 (S2)                                                               |
| 0004 | Position-encoding support scope / client matrix                                                                                                                                                                                                                                                                                                                                                                                    | Phase 0 (S3)                                                               |
| 0005 | Worker-thread migration for core (only if budget exceeded)                                                                                                                                                                                                                                                                                                                                                                         | Phase 0 (S4)                                                               |
| 0006 | Core's TypeScript type-resolution strategy (self-contained resolver vs. `@vue/compiler-sfc`'s `resolveTypeElements`) — supersedes part of ADR-0002                                                                                                                                                                                                                                                                                | Phase 1 (Step 3)                                                           |
| 0007 | Adapter-settings runtime validation location (analyzer, not either host) — implementation lands Phase 2 Track 4                                                                                                                                                                                                                                                                                                                   | Phase 1                                                                    |
| —    | excludeFiles ignore semantics — decided (silent ignore, adapter-markuplint.md §10); no ADR needed, already implemented in Phase 1 Step 4                                                                                                                                                                                                                                                                                          | Phase 1                                                                    |
| —    | Adapter-version vs. session-generation in the validation cache key — decided (session generation subsumes it, no SPI field added; analyzer.md §10.2); no ADR needed, recorded directly in the design doc, implemented in Phase 2 Track 2                                                                                                                                                                                        | Phase 2                                                                    |
| —    | `MappingEntry` transformation group ID; variant warning default; display cap; pull diagnostics; `getConfigFingerprint` SPI; config-parse-error grace period; the standalone analyzer-diagnostics cache layer in monorepo.md §10.2 (default: drop the row rather than implement it, unless measurements show remap/aggregation cost demands it) | Phase 2 (after measurement)                                                |
| 0008 | External-adapter trust model: no sandboxing, no curated specifier allowlist, no PnP support in v1 — loading stays a trust boundary exactly as adapter-loader.md already designed                                                                                                                                                                                                                                                 | Phase 3                                                                    |
| 0009 | Language server distribution: ships standalone (stdio binary + library entry point); no bundled editor client in this release                                                                                                                                                                                                                                                                                                    | Phase 3                                                                    |
| —    | CLI follow-ups: SARIF/other CI-native output formats, file-level parallel analyze (cli.md §10) — watch mode, stdin input, and a persistent cross-run cache are scoped out through Phase 3 (product decision, 2026-08-21) and off this backlog unless revisited                                                                                                                                                                                                                                                                        | After the initial release / after the Phase 2 workspace-scale measurements |
| —    | Wrapped-adapter contract sufficiency                                                                                                                                                                                                                                                                                                                                                                                               | Phase 4                                                                    |

---

## Appendix: Design-test traceability

Maps every numbered test in the design docs to the phase/step that implements it, so scope misassignments are mechanically checkable. "→" means the test lands in parts.

### core.md §10

| Tests         | Lands in                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| 3, 8–15, 17   | Phase 1 Step 3                                                                                         |
| 4             | Phase 1 (literal union / nullish / general string) → Phase 2 Track 1 (unevaluable-expression fallback) |
| 7             | Phase 1 (component/slot/`v-html` exclusion) → Phase 2 Track 1 (custom directives)                      |
| 1–2, 5, 6, 16 | Phase 2 Track 1                                                                                        |

### analyzer.md §12

| Tests                              | Lands in                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1–2, 4, 10–11, 15–16               | Phase 1 Step 5                                                                                     |
| 3                                  | Phase 1 (static/dynamic) → Phase 2 Track 2 (synthetic)                                             |
| 12                                 | Phase 1 (no new work / no leftover result after abort) → Phase 2 Track 2 (no leftover cache entry) |
| 5–9, 13–14, 17                     | Phase 2 Track 2                                                                                    |
| 18 (concrete config watch targets) | Phase 3 task 2                                                                                     |

### language-server §13

| Tests                                                           | Lands in                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 13.1-1                                                          | Phase 1 (UTF-16) → Phase 2 Track 3 (other encodings, if ADR-0004 requires them) |
| 13.1-2                                                          | Phase 1 Step 6                                                                  |
| 13.2-1, 2, 3, 6; 13.3 E2E                                       | Phase 1 Step 7 (the E2E's Phase-2-annotated assertions land in Phase 2)         |
| 13.1-3; 13.2-4, 5, 7, 10                                        | Phase 2 Track 3                                                                 |
| 13.1-4, 5; 13.2-8, 9                                            | Phase 2 Track 4                                                                 |
| 13.1-6                                                          | Phase 3                                                                         |
| 13.1-7 (candidate/concrete config watchers)                     | Phase 3 task 2                                                                  |
| 13.2-11 (dynamic concrete-target registration and invalidation) | Phase 3 task 2                                                                  |

### adapter-markuplint §9.2

| Tests                                                                                           | Lands in        |
| ----------------------------------------------------------------------------------------------- | --------------- |
| 1, 3, 5–11, 14; dispose half of 12; nested-config fixture (two SFCs, different nearest configs) | Phase 1 Step 4  |
| 2, 4; reconfigure half of 12; `excludeFiles` decision fixture                                   | Phase 2 Track 5 |
| 13 (version matrix)                                                                             | Phase 3         |
| 15 (concrete config watch targets)                                                              | Phase 3 task 2  |

### adapter-testkit §3 / §6

| Cases                                                             | Lands in       |
| ----------------------------------------------------------------- | -------------- |
| §3.1–3.7 (minus concurrency depth), §3.9; one seed broken adapter | Phase 1 Step 2 |
| §3.8, §3.10; full §6 broken-adapter suite; §5 sample adapter      | Phase 3        |

### settings.md §8

| Tests | Lands in                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–9   | Phase 2 Track 4 (the package is created with the language-server settings work; the schema-export test completes with Phase 3 release engineering) |

### cli.md §9

| Tests | Lands in                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------- |
| 1–14  | Phase 3 task 5 (the Phase 2 internal runner is unpublished and carries no public test surface) |

### adapter-loader.md §6

| Tests | Lands in                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| 1–8   | Phase 3 task 3 (item 8's shared host contract fixture also runs inside language-server §13.1 and cli.md §9) |

monorepo.md §12.2's E2E items already carry Phase 1 / Phase 2 / Phase 3 annotations in the design doc itself.
