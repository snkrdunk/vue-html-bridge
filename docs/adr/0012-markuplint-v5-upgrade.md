# ADR-0012: Upgrade the pinned Markuplint major to v5, and point it at a fork build

Status: Accepted
Date: 2026-10-06

## Context

`@markuplint/ml-core`'s `NodeStore` has a memory-leak bug upstream
(https://github.com/markuplint/markuplint/pull/4081) with a fix that has not
been released yet. To unblock on it without waiting for the release, the
Markuplint dependency was pointed at a local build of
https://github.com/nagashimam/markuplint/tree/fix/ml-core-nodestore-memory-leak
via a `link:` override in `pnpm-workspace.yaml`. That branch is based on
Markuplint's `v5.0.1` (`markuplint`, `@markuplint/ml-core`, and
`@markuplint/rules` are all `5.0.1`), a major version past the `^4.18.3` pin
ADR-0003 established — so taking the fix means upgrading the pinned major,
not just swapping a build.

Two follow-up requirements came out of exercising this in practice:

1. The original `link:` target lived under
   `~/dev/markuplint/.claude/worktrees/fix-ml-core-nodestore-leak`, a path a
   different tool could reasonably clean up as scratch space. Moved (via
   `git worktree move`) to the stable sibling path
   `~/dev/markuplint-fix-ml-core-nodestore-leak`.
2. Markuplint's own package dependencies use plain version numbers, not the
   `workspace:*` protocol, so overriding `markuplint` alone would still
   resolve `@markuplint/ml-core` from the registry's unfixed `5.0.1` —
   defeating the point. `@markuplint/ml-core` needs its own `link:` override
   to the same fork build. `@markuplint/rules` additionally needs one: unlike
   everything else, `spikes/s2-markuplint/generate-rule-manifest.spike.test.ts`
   reads `@markuplint/rules`'s installed files directly by path rather than
   importing `markuplint`, so without the override it would silently keep
   seeing the registry's `4.18.3` `@markuplint/rules` and never notice the
   major-version drift.

## Decision

**Pin `markuplint` to `^5.0.1`** (peer dependency on
`@vue-html-bridge/adapter-markuplint`, matching the fork build), via `link:`
overrides in `pnpm-workspace.yaml` for `markuplint`, `@markuplint/ml-core`,
and `@markuplint/rules`, all pointing at
`~/dev/markuplint-fix-ml-core-nodestore-leak/packages/...`. Revert to a plain
registry version pin once PR #4081 ships in a release.

### What the v5 rule-system redesign (#3989) changed

Markuplint v5 renamed and split most rules (tracked by
`@markuplint/ml-config`'s rule-alias table, in
`@markuplint/rules/src/rule-aliases.ts`), and introduced 37 new rules with no
4.18.3 equivalent. The old config keys still resolve (with a
`rule-deprecation` diagnostic) via that alias table, but this repo's own
config fixtures and test assertions were updated to the new names directly,
to avoid depending on a deprecation shim slated for removal in v6:

- 1:1 renames (e.g. `id-duplication` → `no-duplicate-id`,
  `required-attr` → `require-attr`, `end-tag` → `require-end-tag`,
  `disallowed-element` → `no-restricted-element`).
- 1:N splits where every target inherits the same verdict (e.g.
  `character-reference` → `no-malformed-character-reference` +
  `no-unescaped-char`; `wai-aria` → 21 granular ARIA rules, all `a11y`/
  `html-semantics`/kept, per `rule-aliases.ts`'s own note that each "already
  ran its single check unconditionally once split off from the umbrella").
- 1:N splits re-derived per target, where the halves genuinely differ in
  document-dependency: `required-h1` → `require-h1` (the missing-h1 half,
  stays disabled — document-root-only, same as before) and `no-duplicate-h1`
  (the duplicate-h1 half — now kept, since 2+ real `<h1>`s inside one
  fragment is a genuine violation regardless of document placement, unlike
  the missing-h1 case).

### Rule manifest v1, re-derived for v5 (107 rules, up from 38)

`packages/adapter-markuplint/fixtures/rule-manifest.v1.json` is regenerated
by `spikes/s2-markuplint/generate-rule-manifest.spike.test.ts` against the
now-linked v5 rules package: **107 rules** (88 kept / 19 disabled), each
rule's `category` read from its own `meta.js` (v5 uses a completely
different category taxonomy — `style`/`structure`/`references`/`attributes`/
`forms`/`syntax`/`compat`/`a11y` — than 4.18.x's `validation`/`style`/
`naming-convention`/`a11y`/`maintainability`; this is cosmetic metadata only,
not consumed by the overlay logic). That generator script also needed a
structural fix: v5 left 4 directories under `@markuplint/rules/lib`
(`wai-aria`, `landmark-roles`, `srcset-sizes-constraint`,
`table-row-column-alignment`) that are no longer standalone rules — just
shared helper modules the split rules still import — with no `meta.js`.
`realRuleIdsWithCategory()` now skips any directory whose `meta.js` import
fails, instead of treating every directory as a rule.

Three new disables, not present in the 4.18.3 manifest, were added for rules
v5 enables by default that don't suit a virtual/generated fragment:

- `require-doctype` / `no-obsolete-doctype` (split from `doctype`, same
  document-root-only reasoning as before) — **this was the main source of
  test breakage before the manifest was regenerated**: `require-doctype` is
  enabled by default via `markuplint:html-standard` (itself pulled in by
  `markuplint:recommended-static-html`), so every fragment without a
  `<!DOCTYPE>` — i.e. every fragment — failed `require-doctype` once the
  stale 4.18.3 manifest stopped recognizing the rule under its new name.
- `head-element-order`, `meta-charset-position`, `no-content-after-body`,
  `no-stray-head-or-body-tag` (new in v5, all document-root-only for the same
  reason as `doctype`/`head`/`body` always: fragment-local).
- `no-mismatched-aspect-ratio` (new in v5, enabled by default via
  `markuplint:performance`): compares an `<img>`/`<source>`'s declared
  `width`/`height` against the *real* referenced image file's actual
  dimensions. A generated/virtual fragment's image paths aren't resolvable on
  disk (ADR-0003 criterion 1), so this would either silently false-negative
  or fail trying to resolve a nonexistent file.
- `attr-order`, `no-experimental-features`, `no-nonstandard-features`,
  `no-unsupported-browser-features` (new in v5; the latter three need
  project-specific browserslist config this adapter doesn't provide).

One behavior change surfaced incidentally and is not a manifest concern:
`markuplint:performance`'s `img-aspect-ratio` nodeRule requires `width`/
`height` on `<img src>` via the same shared `require-attr` rule ID as the
pre-existing `alt` requirement — an `<img>` with `alt` but no `width`/
`height` now still reports `require-attr`. Two `spikes/` fixtures assuming
"has `alt`" ⇒ "clean" were updated to include `width`/`height`.

## Consequences

1. **Design-doc update**: `docs/design/monorepo.md` §14's Phase 0 log and
   `docs/design/packages/adapter-markuplint.md` §3/§5 now reference the
   `5.0.1` pin and this ADR; §5's rule-manifest summary states 107/88/19 and
   the current example rule names instead of 38/29/9 and the 4.18.x names.
2. **Implementation task**: no new implementation-plan.md item — this is a
   dependency-version maintenance decision, not new product scope.
   `packages/adapter-markuplint/package.json`'s `markuplint` peer/dev
   dependency, `spikes/package.json`'s `markuplint`/`@markuplint/config-presets`/
   `@markuplint/rules` dependencies, and `.github/workflows/ci.yml`'s
   version-pin comment are updated to `5.0.1`/`^5.0.1`.
3. **Verifying test**: every `packages/adapter-markuplint/src/index.test.ts`
   rule-ID assertion now uses the v5 name; same for
   `spikes/s2-markuplint/*.spike.test.ts`,
   `packages/language-server/src/{e2e,server}.test.ts`, and
   `packages/cli/src/{cli.e2e,options,output/ndjson}.test.ts`. All packages'
   `test`/`typecheck`/`lint`/`format:check`/`check:deps` pass against the new
   pin (verified 2026-10-06), except one pre-existing, unrelated failure in
   `packages/cli/src/install-skill.test.ts` (an in-progress, uncommitted
   feature predating this upgrade).

## Alternatives considered

- **Point the `markuplint` override at the GitHub fork URL directly** (e.g.
  `github:nagashimam/markuplint#fix/ml-core-nodestore-memory-leak&path:packages/markuplint`),
  instead of a local `link:` build — rejected for now: the fork's `lib/`
  build output is gitignored and not committed to the branch, and
  `packages/markuplint/package.json`'s own dependency on
  `@markuplint/ml-core` is a plain `5.0.1` version (not `workspace:*`), so a
  bare git-subdirectory dependency would need the fork to add a `prepare`
  build step (or commit `lib/`) *and* a matching git override for
  `@markuplint/ml-core` to actually carry the fix through, rather than
  silently resolving the unfixed registry version underneath a
  seemingly-successful install. A local `link:` build sidesteps all of this
  by reusing the fork checkout's own already-built, already-linked
  `node_modules`.
- **Carry the old rule names in config via the deprecation-alias shim**
  instead of updating every fixture/assertion to the v5 names — rejected:
  `rule-aliases.ts` itself documents that the shim is removed in v6, and
  leaving it in place would mean the actual firing violations still report
  under the *new* name regardless (aliasing only expands config keys, not
  violation output), so old-named assertions would still need to change; the
  shim would only have hidden the config-key side of the same migration.

