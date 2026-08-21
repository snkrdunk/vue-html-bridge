# S2 findings — Markuplint in-memory API (feeds ADR-0003)

Real code against installed `markuplint@4.18.3`: `api-usage.spike.test.ts`,
`violation-location.spike.test.ts`, `generate-rule-manifest.spike.test.ts`,
`generate-config-search-fixture.spike.test.ts` (15 tests, all passing).
Committed artifacts: `packages/adapter-markuplint/fixtures/rule-manifest.v1.json`,
`packages/adapter-markuplint/fixtures/config-search-filenames.json`.

adapter-markuplint.md §3.1's acceptance criteria, in order:

## 1. In-memory validation without a filesystem write — PASS, no temp-file fallback needed

The real API is **`MLEngine.fromCode(sourceCode, options)`**, not the design
doc's illustrative `MLEngine` constructor + `createInMemoryMlFile` sample.
`fromCode` builds an in-memory `MLFile` (`_type: 'code-base'`) whose
`getCode()` returns the string directly — confirmed nothing is written to
disk (`access(virtualName)` rejects after linting).

**`sourceFilename`/`virtualFilename` separation (monorepo.md §15,
adapter-markuplint.md §4.2) confirmed working**: `MLFile.path` is computed as
`path.resolve(dirname, basename)` from `workspace`/`name`. Passing `name` as
an **absolute** path and omitting `workspace` makes `file.path` equal that
absolute path exactly, and `overrides`/`parser`/`excludeFiles` matching is
evaluated against `file.path` — i.e. against `virtualFilename`, decoupled
from `sourceFilename`'s real directory. This is exactly the separation the
design doc requires. Build the documented
`…/<source>.__vue_html_bridge__/variant-<hash>.html` shape as an absolute
path and pass it as `name`.

## 2. `extends`/plugins/`rules`/`nodeRules` resolve — PASS

Verified against a real config (`fixtures/bridge-config.json`) combining a
top-level `rules` entry, a `nodeRules` entry (`img` requires `alt`), and
`extends: markuplint:recommended-static-html`.

## 3. Vue parser mapping doesn't apply to the virtual `.html` — PASS

Config maps `\.vue$` → `@markuplint/vue-parser` (deliberately **not**
installed in the spike workspace). Linting the `.html`-suffixed virtual name
never attempts to resolve that parser (which would throw module-not-found if
the regex matched) — proves the mapping is evaluated against the actual
target filename, not the original SFC path.

## 4. Violation `line`/`col`/`raw` semantics — PASS, fully pinned down

- `line` and `col` are both **1-based**.
- The unit is **UTF-16 code units** — confirmed with both an emoji (surrogate
  pair: `<p>` (3 units) + 😀 (2 units) → next token starts at col 6, not col 5
  as code-point counting would give) and a combining mark (`e` + COMBINING
  ACUTE ACCENT counted as 2 separate units, not 1 grapheme).
- **No explicit `end` field** on `Violation` — derive
  `end = start + raw.length` (UTF-16 code units). `raw` can itself span
  multiple lines (e.g. an opening tag broken across lines); this doesn't
  complicate the math since `start` is already an absolute offset.
- CRLF counts as one line break for `line` purposes.
- A position-less violation (e.g. `config-error` from a bad config path)
  reports `raw: ""` at `(line: 1, col: 1)` — **must** be treated as "no
  usable range" (adapter-markuplint.md §6.1's zero-width/undefined case), not
  a real one-column range at the document start.

## 5. Engine/file reuse and concurrency — PASS, recommend keeping `maxConcurrentValidations: 1` (reason reframed)

- `engine.setCode()` re-parses without re-resolving config — real reuse path
  matching adapter-markuplint.md §4.3's shared per-session config context.
- 8 concurrent independent `MLEngine` instances validated in parallel via
  `Promise.all` showed no cross-talk (`result.filePath` and violations
  matched their own input in every case).
- This spike found **no evidence of unsafe shared state** at the surface
  tested (independent `MLEngine` instances, simple config). It did not stress
  a *shared* engine instance under concurrent `validate`-style calls, nor
  heavier real-world config (plugins with module-level state, larger
  documents). **Recommendation**: keep `maxConcurrentValidations: 1` for the
  Phase 1 vertical slice, but record in ADR-0003 that this is a conservative
  default carried forward pending a *targeted* concurrency stress spike
  later (not a demonstrated hazard) — the original design doc's framing
  ("not yet confirmed safe") already matches this; nothing here justifies
  raising it yet, but nothing found actively contradicts raising it later
  either.

## 6. Generated-html profile rule manifest v1 — DONE

`packages/adapter-markuplint/fixtures/rule-manifest.v1.json`: all 38 rules
from the installed `@markuplint/rules` package (`meta.js`'s own `category`
field — `validation` vs. `style`), classified as kept/disabled with a reason,
plus an `applicability` tag (`html-semantics` / `source-representation` /
`document-context`) on every kept rule, matching adapter-markuplint.md §5's
three examples directly:

- `no-use-event-handler-attr` → `source-representation` (an `onclick`
  generated from `@click` can't be told apart from a hand-written one by
  looking at the HTML string alone — analyzer.md/adapter-markuplint.md §5's
  worked example).
- `no-refer-to-non-existent-id`, `landmark-roles`, `heading-levels`
  (document/host-context-dependent) → `document-context`.
- Everything else content-model/attribute-value/ARIA-semantic → `html-semantics`.

**Real finding, not assumed**: `markuplint:code-styles` (the preset the
design doc's §5 prose seems to assume as the "style" baseline) is **empty**
in markuplint 4.18.x. The profile should instead be built on
**`markuplint:recommended-static-html`** — the built-in preset that already
re-enables `character-reference` and `end-tag` specifically for
non-templated static HTML output, which matches exactly what generated
fragments are. `api-usage.spike.test.ts`'s criterion-2 test empirically
confirms `extends: markuplint:recommended-static-html` pulls in `end-tag`.

29 of 38 rules stay kept; 9 are disabled (source-formatting-only, e.g.
`attr-value-quotes`, `attr-equal-space-before`, or document-root-only rules
disabled by default per adapter-markuplint.md §5's stated policy).

## 7. Config-search filename fixture — DONE, real doc gap found

`packages/adapter-markuplint/fixtures/config-search-filenames.json`: derived
from `cosmiconfig`'s actual `getDefaultSearchPlaces("markuplint")` (21
entries), cross-checked against `adapter-markuplint.md §2`'s documented
`configFilePatterns` (4 globs:
`**/.markuplintrc`, `**/.markuplintrc.*`, `**/markuplint.config.*`, `**/package.json`),
and empirically verified with a real upward-search test
(`.config/markuplintrc.json` two directories up from an unconfigured nested
directory, no explicit `configFile`, resolves and applies).

**Gap found**: none of the 4 documented globs match any of the 8
`.config/markuplintrc*` search targets (`.config/markuplintrc`,
`.config/markuplintrc.json`, `.config/markuplintrc.yaml`, `.yml`, `.js`,
`.ts`, `.cjs`, `.mjs`) — a bare `.config/markuplintrc.js` has no leading dot
on the filename component itself, so `**/.markuplintrc.*` (which requires
the matched filename to *start* with a dot) never matches it. Left
unaddressed, the language server's config-file watcher (language-server.md
§9.3) would silently never notice a newly created `.config/markuplintrc.*`.
This needs a glob fix as part of ADR-0003's design-doc update.
