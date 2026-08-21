# ADR-0003: Markuplint API usage, version pin, and config-search patterns

Status: Accepted
Date: 2026-08-21

## Context

adapter-markuplint.md §3.1 lists seven acceptance criteria that must be
confirmed with real code before pinning a Markuplint version, and the
design doc's own `MLEngine`/`createInMemoryMlFile` code sample is explicitly
"conceptual" pending this spike. implementation-plan.md §3.2 (Spike S2)
requires this ADR to cover API usage and version policy, and treats the
resulting rule manifest as a hard gate for Phase 1 (adapter-markuplint.md
§5, monorepo.md §14).

The spike's real code lives in `spikes/s2-markuplint/` against installed
`markuplint@4.18.3` (see `FINDINGS.md` there for the full writeup, and
`api-usage.spike.test.ts` / `violation-location.spike.test.ts` for the
executable evidence).

## Decision

**Pin `markuplint` to `^4.18.3`** (peer dependency on
`@vue-html-bridge/adapter-markuplint`, matching CI). All seven criteria pass
with real code; no temporary-file fallback is needed.

### Real API usage (replaces adapter-markuplint.md §3's conceptual sample)

The public entry point is **`MLEngine.fromCode(sourceCode, options)`**, not a
constructor plus a separate in-memory-file helper:

```ts
import { MLEngine } from "markuplint";

const engine = await MLEngine.fromCode(html, {
  name: virtualFilenameAbsolutePath, // MUST be absolute; workspace omitted
  configFile: resolvedConfigFile,
  noSearchConfig: true,
  fix: false,
  locale: settings.locale,
});
const result = await engine.exec();
await engine.close();
```

- **`sourceFilename` vs. `virtualFilename` separation (adapter-markuplint.md
  §4.2) is confirmed working**: `MLFile.path` resolves from `workspace`/`name`
  as `path.resolve(dirname, basename)`. Passing `name` as an **absolute**
  path and omitting `workspace` makes `file.path` equal that path exactly —
  `overrides`/`parser`/`excludeFiles` matching (evaluated against
  `file.path`) is therefore fully decoupled from `sourceFilename`'s real
  directory, exactly as the design requires. The adapter must build the
  documented `…/<source>.__vue_html_bridge__/variant-<hash>.html` shape as an
  absolute path before passing it as `name`.
- No filesystem write occurs for this path (confirmed: `access(virtualName)`
  rejects after linting) — criterion 1 passes without a temp-file fallback.
- `extends`/plugins/`rules`/`nodeRules` resolve correctly from an explicit
  `configFile` (criterion 2); a Vue-parser mapping in config never applies to
  the `.html`-suffixed virtual name, since the mapping is a regex tested
  against `file.path` (criterion 3).
- `engine.setCode()` reuses a resolved config for repeated validation without
  re-resolving it (criterion 5's reuse half); 8 concurrent independent
  `MLEngine` instances showed no cross-talk (criterion 5's concurrency half).
  **`maxConcurrentValidations` stays at the design doc's conservative `1`** —
  this spike found no evidence of a problem, but it did not stress a
  *shared* engine instance or heavier real config, so raising it is left for
  a dedicated future measurement, not decided here.

### Violation location semantics (adapter-markuplint.md §6.1)

- `line`/`col` are **1-based**; the unit is **UTF-16 code units** (confirmed
  against an emoji surrogate pair and a combining-mark sequence — Markuplint
  counts code units, matching JS string indexing, not Unicode code points or
  grapheme clusters).
- `Violation` has **no explicit `end` field** — derive
  `end = start + raw.length` (UTF-16 code units); this holds even when `raw`
  spans multiple lines.
- A violation with no locatable position (e.g. a `config-error`) reports
  `raw: ""` at `(1, 1)` — the adapter must treat empty `raw` as "no usable
  range" per §6.1's existing zero-width/undefined rule, never as a literal
  one-column range at the document start.

### Generated-html profile rule manifest v1 (Phase 1 gate)

Committed as `packages/adapter-markuplint/fixtures/rule-manifest.v1.json`:
all 38 rules from the installed `@markuplint/rules` package, each tagged
`keptInGeneratedHtmlProfile` (29 kept / 9 disabled) with a reason, and an
`applicability` classification (`html-semantics` / `source-representation` /
`document-context`) on every kept rule, matching adapter-markuplint.md §5's
three worked examples exactly (`no-use-event-handler-attr` →
`source-representation`; `no-refer-to-non-existent-id` /
`landmark-roles` / `heading-levels` → `document-context`; everything else
content-model/ARIA-semantic → `html-semantics`).

**Correction to adapter-markuplint.md §5's implied baseline**:
`markuplint:code-styles` is **empty** in markuplint 4.18.x. The
`generated-html` profile is built on **`markuplint:recommended-static-html`**
instead — the built-in preset that already re-enables `character-reference`
and `end-tag` specifically for non-templated static output, which is exactly
what generated fragments are (empirically confirmed: this extend chain is
what turns on `end-tag`).

### Config-search filename fixture (S2 criterion 7)

Committed as `packages/adapter-markuplint/fixtures/config-search-filenames.json`,
derived from `cosmiconfig`'s real `getDefaultSearchPlaces("markuplint")` (21
entries) and empirically verified with an upward-search test.

**Documented `configFilePatterns` (adapter-markuplint.md §2) has a real gap,
now fixed**: none of the 4 previously-documented globs
(`**/.markuplintrc`, `**/.markuplintrc.*`, `**/markuplint.config.*`,
`**/package.json`) match any of the 8 `.config/markuplintrc*` search targets,
because `**/.markuplintrc.*` requires the matched filename itself to start
with a dot, and `.config/markuplintrc.js` does not (the dot is on the
directory, not the filename). The corrected pattern list adds
`**/.config/markuplintrc` and `**/.config/markuplintrc.*`:

```jsonc
"configFilePatterns": [
  "**/.markuplintrc",
  "**/.markuplintrc.*",
  "**/.config/markuplintrc",
  "**/.config/markuplintrc.*",
  "**/markuplint.config.*",
  "**/package.json"
]
```

## Consequences

1. **Design-doc update**: adapter-markuplint.md §3 replaces its conceptual
   code sample with the real `MLEngine.fromCode` usage above; §2's
   `configFilePatterns` list gains the two `.config/` globs; §5 references
   the committed rule-manifest fixture and corrects the profile's extend
   target to `markuplint:recommended-static-html`; §6.1 states the confirmed
   line/col/raw semantics plainly instead of "will be pinned down."
2. **Implementation task**: Phase 1 Step 4
   (`@vue-html-bridge/adapter-markuplint`) in implementation-plan.md
   implements the session/`validate` path against this confirmed API;
   `packages/adapter-markuplint/package.json` gains a real `markuplint`
   dependency pinned to this version; `.github/workflows/ci.yml`'s
   Markuplint-version-matrix TODO is resolved by pinning this version (matrix
   growth stays deferred until a second supported major, per the doc's
   existing policy).
3. **Verifying test**: `spikes/s2-markuplint/*.spike.test.ts` (15 tests) is
   the evidence for this ADR; adapter-markuplint.md §9.2 item 14 (the real,
   non-spike drift test asserting `configFilePatterns` against the committed
   fixture) is implemented in Phase 1 Step 4 per implementation-plan.md's
   traceability appendix, and must use the corrected pattern list above.

## Alternatives considered

- **Temp-file fallback**: not needed — criterion 1 passed directly against
  `MLEngine.fromCode`. The design doc's fallback plan (safe temp dir,
  collision-free names, `finally` cleanup, preserving the
  `sourceFilename`/`virtualFilename` contract) remains documented as a
  contingency but is not implemented.
- **Raising `maxConcurrentValidations` above 1 now**: rejected — the spike's
  concurrency test used independent `MLEngine` instances with a simple
  config, which is a narrower claim than "safe under all realistic
  concurrent load." Revisit with a dedicated stress spike (shared engine
  instance, plugin-heavy config, larger documents) if profiling later shows
  `maxConcurrentValidations: 1` is a real throughput bottleneck.
- **Basing the profile on `markuplint:recommended` instead of
  `markuplint:recommended-static-html`**: rejected — `recommended` assumes a
  full hand-authored document and doesn't specifically address the
  static/generated-output distinction adapter-markuplint.md §5 is built
  around; `recommended-static-html` is markuplint's own purpose-built preset
  for exactly this case.
