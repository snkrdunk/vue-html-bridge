# ADR-0011: `--emit-html` debug dump of generated HTML

Status: Accepted
Date: 2026-09-01

## Context

Running `vue-html-bridge` against a real-world SFC produced:

```
src/components/account/OrderItem.vue:1:11 error character-reference
  Illegal characters must escape in character reference (could not be traced back to specific source syntax) (4 variants) [markuplint]
```

`1:11` is the documented fallback position used whenever a validator
diagnostic's range cannot be reverse-mapped to source (analyzer.md §6.2,
`mappingFallback: true`); `(4 variants)` is the two-stage diagnostic
identity model's cross-variant aggregation (analyzer.md §8.1/§8.2). Both are
correct, already-shipped, already-tested behavior — but neither gives a user
any way to see the actual generated HTML that was linted, so a
fallback-positioned, multi-variant diagnostic like this is effectively
uninterpretable: there is no way to tell which variant, or which piece of
markup, triggered the rule.

This is exactly the scenario the Phase 1-3 scope decision (2026-08-21)
anticipated when it scoped out "an opt-in debug API dumping
variants/mapping/generated HTML," with the explicit reasoning "ship without
it, revisit if real-world debugging needs justify it later." That trigger
occurred. The product decision to build a debug-dump capability was
confirmed during PRD collection for this run (`docs/local/sdd/emit-html`);
this ADR records the resulting engineering decisions (Q1-Q5 from that run's
`plan.md`), now implemented.

## Decision

Add an opt-in CLI flag, **`--emit-html <dir>`**: when passed, every
generated HTML variant is written to disk under `<dir>`, reusing the
existing virtual-filename convention (analyzer.md §5.2:
`<file>.__vue_html_bridge__/variant-<hash>.html`), alongside a paired JSON
sidecar carrying the variant's decisions and mapping/provenance data. No
behavior change when the flag is omitted.

### Q5 — package placement: analyzer-only, no core changes

`HtmlVariant`/`DecisionAssignment`/`MappingEntry` (core.md §2.2) are already
plain, JSON-shaped types exported from `vue-html-bridge`; nothing here
needed a new core API. The actual, verified gap was in
`@vue-html-bridge/analyzer`: `workspace-analyzer.ts`'s `analyze()` already
computed `generated.variants` (full `HtmlVariant[]`, including
`.decisions`/`.map`) and, via `buildWorkItems`, the hash-grouped
`virtualFilename` per unique HTML — but discarded both once diagnostics were
built; `AnalysisResult` never retained them. Added: an opt-in
`CreateWorkspaceAnalyzerOptions.collectVariantArtifacts` flag (constructor-level,
since `--emit-html` is a whole-run flag and the CLI creates one
`WorkspaceAnalyzer` per run) and an optional `AnalysisResult.variantArtifacts`
field, populated independent of adapters/diagnostics (so it's present even
for a clean run with zero diagnostics or zero adapters — the point is
showing generated HTML, not diagnostic-linked HTML). Verified, not just
assumed: the generation cache already stores the full `GenerateResult`
(including `.variants`) regardless of this option, so it must never be
added to `generationCacheKey`/`validationCacheKey` — doing so would
fragment the cache for no reason.

### Q1 — sidecar shape: one JSON file per emitted HTML file

`workspace-analyzer.ts` already treats the representative variant's `.map`
as standing in for its whole hash-group when building diagnostic
occurrences — an existing precedent for "one shared mapping per HTML-hash
group." The sidecar reuses this: `variant-<hash>.json` alongside
`variant-<hash>.html`, containing every member variant's `decisions` (a
hash-group can have more than one member — REQ-6) plus the representative's
`map`. A single per-run manifest was considered and rejected: nothing in
the stated need (correlate *a* variant back to its conditions) requires a
run-wide index, and one would be exactly the "new mechanism where an
existing one would do" this feature's own rationale argues against.

Shape (`packages/cli/src/emit-html.ts`, `EmitHtmlSidecar`):

```jsonc
{
  "htmlFile": "variant-<hash>.html",
  "sourceFilename": "<workspace-relative path>",
  "variants": [
    { "variantId": "...", "decisions": [ { "decisionId": "...", "displayName": "...", "value": null } ] }
  ],
  "map": [ /* the representative variant's MappingEntry[] */ ]
}
```

### Q2 — no new NDJSON record

The existing NDJSON contract states "the output never contains generated
HTML or source text" (cli.md §7.2); a new record pointing only at paths
would respect that but has no stated tooling/editor-integration need behind
it yet. Deferred, applying the same "ship minimal, revisit on real need"
principle that created this whole feature. Instead: one stderr notice per
run (not per file), mirroring the existing `--untrusted` stderr-notice
precedent (cli.md §5) — `--emit-html: wrote N variant file(s) under
"<dir>".`

### Q3 — `--untrusted` interaction: host-neutral

`--untrusted` restricts settings that can cause workspace code to run
(cli.md §5). `--emit-html` runs no additional workspace code and only
writes a deterministic transform of source the operator already gave the
CLI access to, to a location the *operator* (not analyzed content) names via
their own flag — the same trust shape as redirecting stdout to a file,
which `--untrusted` also doesn't restrict. Verified end-to-end
(`cli.e2e.test.ts`, "composes with --untrusted").

### Q4 — `<dir>` lifecycle: create-if-missing, clean tool-owned subdirectories only

Content-hash-keyed filenames mean a variant no longer generated (source
changed) would become a silently permanent orphan under overwrite/append
semantics. `error-if-exists` was rejected as hostile to the expected
edit-then-rerun workflow. Decision: at the start of each run passing
`--emit-html <dir>`, create `<dir>` if missing, then recursively remove only
subdirectories whose name ends with `.__vue_html_bridge__` — never anything
else under `<dir>`, at any depth. This is the highest-risk piece of the
whole feature (a bug could delete user content); `emit-html.test.ts` proves
unrelated files/directories under `<dir>` survive a run.

### A sixth decision made during implementation, extending Q1-Q5: relative-`<dir>` resolution

Not resolved by the collection/definition/planning stages (flagged as a new
open assumption in `test-specs.md`). Decided during implementation,
consistent with cli.md §4.2's existing documented role for
`--workspace-root` ("... relative output paths"): a relative `--emit-html
<dir>` resolves against `workspaceRoot`, not the process's cwd
(`packages/cli/src/cli.ts`). Not `realpath()`'d — the directory need not
exist yet (`prepareEmitHtmlDir` creates it), matching `virtualFilename`'s
own "the path does not need to exist on the filesystem" contract
(analyzer.md §5.2).

### Write failures

A per-file `--emit-html` write failure is reported once as a run-level
error (`emit-html/write-error`, cli.md §8's run-outcome model) without
aborting analysis of the remaining files — failure isolation, exactly like
an adapter or file-read failure. A `prepareEmitHtmlDir` setup failure
(`emit-html/setup-error`, e.g. permission denied) is reported once and
disables `--emit-html` for the rest of that run, but does not abort file
analysis itself.

## Consequences

1. **Design-doc update:** cli.md §4.2 (new `--emit-html <dir>` flag row);
   analyzer.md §5.2/§9 (new `collectVariantArtifacts` option,
   `AnalysisResult.variantArtifacts`, `VariantArtifact` shape) — both
   updated alongside this ADR.
2. **Implementation task:** `packages/analyzer/src/work-deduplication.ts`
   (`groupVariantsByHtml` extracted from `buildWorkItems`),
   `packages/analyzer/src/types.ts` (`collectVariantArtifacts`,
   `VariantArtifact`, `VariantArtifactMember`),
   `packages/analyzer/src/workspace-analyzer.ts` (population),
   `packages/analyzer/src/index.ts` (re-exporting the two new public types —
   required for `@vue-html-bridge/cli` to import them at all, since the
   package only exports its `index.js` barrel; not anticipated in the
   original plan's per-task write-scope list, added as a minimal, type-only
   necessity), `packages/cli/src/options.ts` (`--emit-html <dir>` flag +
   help text), `packages/cli/src/emit-html.ts` (new: path composition,
   sidecar serialization, directory lifecycle, stderr notice),
   `packages/cli/src/runner.ts` (wiring, write-failure/setup-failure
   handling), `packages/cli/src/cli.ts` (resolving a relative `<dir>`
   against `workspaceRoot` and threading it into `runCli`; likewise not on
   the original write-scope list, for the same reason).
3. **Verifying test:** `packages/analyzer/src/index.test.ts` (artifact
   population, hash-grouping/collapse, REQ-8 negative case at the analyzer
   layer); `packages/cli/src/options.test.ts` (flag parsing, usage error,
   REQ-8 negative case at the parsing layer); `packages/cli/src/emit-html.test.ts`
   (path composition, sidecar shape, directory-lifecycle safety, notice
   text); `packages/cli/src/runner.test.ts` (wiring, spy-based REQ-8
   negative case, write-failure isolation); `packages/cli/src/cli.e2e.test.ts`
   (happy path, REQ-6 collapse, REQ-8 negative case, `--untrusted`
   composition); `packages/cli/src/performance.test.ts` (REQ-8/TC-REQ8-C
   non-regression when the option is omitted).

## Alternatives considered

- **One run-wide manifest instead of a per-HTML-file sidecar (Q1):**
  rejected — no stated need for a run-wide index, and it would duplicate a
  mechanism the per-file pairing already provides more discoverably.
- **A new NDJSON record pointing at emitted paths (Q2):** rejected for v1 —
  no stated tooling/editor-integration need yet; deferred until real usage
  justifies it, the same reasoning that originally deferred this whole
  feature.
- **Restricting or disabling `--emit-html` under `--untrusted` (Q3):**
  rejected — it introduces no new trust-boundary crossing; restricting it
  would be inconsistent with every other host-neutral output flag.
- **Overwrite or append semantics for `<dir>` (Q4):** rejected — both leave
  permanently stale, content-hash-named orphans once a source file changes,
  directly undermining the feature's "what is generated right now" purpose.
- **A core (`vue-html-bridge`) API addition (Q5):** rejected — core already
  exports everything needed as plain data; the actual gap was analyzer
  retaining and returning it, not core computing it.
