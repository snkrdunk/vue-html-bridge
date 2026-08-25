# ADR-0001: Build and release tooling

Status: Accepted
Date: 2026-08-21

## Context

monorepo.md §4.2 names pnpm workspaces as the package manager and lists
Changesets as "a candidate for tracking changelogs and independent versioning
of published packages," deferring the actual decision to an ADR made "when
implementation starts" (implementation-plan.md Stage A, task A7). Stage A
needs a concrete, working build pipeline — per-package `exports`/`types`/`bin`
maps, declaration output, and a `pnpm -r build` that succeeds on empty
packages — before any package has real source to build.

Requirements driving the choice:

- Every published package (`vue-html-bridge`, and all `@vue-html-bridge/*`
  packages except the never-published `adapter-testkit`'s test-only pieces)
  needs its own independent semver (monorepo.md §13).
- The repository is ESM-first (adapter-markuplint.md §3.2), so the compiler
  output and package `exports` must be ESM-only with correct `NodeNext`
  resolution.
- No package should require a bundler to consume; adapters and hosts are
  plain Node ESM libraries, not browser bundles.

## Decision

- **Package manager**: pnpm workspaces (`pnpm-workspace.yaml`), pinned via the
  root `package.json`'s `packageManager` field and installed through Corepack.
- **Compiler**: plain `tsc`, no bundler. Each package has `tsconfig.json`
  (`noEmit: true`, used for `typecheck`, includes test files) and
  `tsconfig.build.json` (extends the former, emits `.js`/`.d.ts`/source maps
  to `dist/`, excludes `*.test.ts`, used for `build`). Both extend the shared
  `tsconfig.base.json` (strict mode, `module`/`moduleResolution: NodeNext`).
- **Cross-package resolution**: no TypeScript project references. Because
  `pnpm -r <script>` executes package scripts in dependency-topological order,
  a package's workspace dependencies are always already built (their
  `dist/index.d.ts` and `package.json#exports` exist) by the time it builds or
  is typechecked. This keeps the tsconfig graph simple at the cost of
  requiring `build` before `typecheck`/`test` can see a dependency's real
  types — the CI job in `.github/workflows/ci.yml` and the exit criteria in
  implementation-plan.md §2 already run `build` first for this reason.
- **Versioning and changelogs**: Changesets (`@changesets/cli`), configured
  now (`.changeset/config.json`) so every Stage-A-and-later PR can carry a
  changeset from the start. `access` stayed `"restricted"` through Phase 3
  implementation, then flipped to `"public"` at Phase 3 release engineering
  (implementation-plan.md §6 task 6, 2026-08-25) alongside removing
  `"private": true` from all 9 publishable packages (the root monorepo
  manifest itself stays private — it is never published). `updateInternalDependencies:
  "patch"` (already set) is what propagates a version bump through the
  dependency graph: changing `vue-html-bridge` (core) bumps every package
  that depends on it, transitively, while a change to `@vue-html-bridge/cli`
  — which nothing depends on — bumps only itself; verified empirically in a
  throwaway worktree before flipping the real flags. An automated CI
  publish workflow (`changesets/action` or equivalent) is not wired yet —
  `pnpm changeset version` / `pnpm changeset publish` are run by hand for
  now.
- **Dependency direction**: enforced by a small custom script
  (`scripts/check-dependency-graph.mjs`, run as `pnpm run check:deps` and
  wired into CI) rather than `dependency-cruiser`. The invariants to check —
  no cycles, core depends on nothing internal, nothing depends on cli, and the
  full edge set matches monorepo.md §4.1 — are graph facts derivable from each
  package's declared `workspace:*` dependencies; a source-import analyzer
  (dependency-cruiser's usual mode) is more machinery than that needs. This
  can be revisited if a future package needs import-level (not just
  package.json-level) enforcement.

## Consequences

1. Design-doc update: monorepo.md §4.2 updated to record this decision
   instead of "a candidate ... decide ... when implementation starts."
2. Implementation task: implementation-plan.md Stage A tasks A2, A3, A6, A7
   (this ADR and the tooling it describes).
3. Verifying test: `pnpm install && pnpm -r build && pnpm -r test` passing in
   CI (Stage A exit criteria) with `check:deps` active; the ESM cross-import
   check is exercised by each downstream package's placeholder test (e.g.
   `packages/analyzer/src/index.test.ts`) actually importing its workspace
   dependencies at runtime.

## Alternatives considered

- **A bundler-based build (tsup/esbuild) per package**: rejected for now —
  nothing in the design docs needs bundling (no browser target, no need to
  inline dependencies), and plain `tsc` gives the most direct, debuggable
  mapping from source to the published `.d.ts`. Revisit if a package
  (unlikely, but e.g. the CLI) turns out to need it for startup-time reasons.
- **TypeScript project references (`composite`/`references`) for build
  ordering**: rejected — `pnpm -r`'s own topological execution already
  guarantees build order across packages, so project references would only
  add config to keep in sync with `scripts/check-dependency-graph.mjs`
  without changing behavior.
- **dependency-cruiser for the dependency-direction lint**: rejected for
  Stage A — see "Dependency direction" above. It remains the documented
  fallback in implementation-plan.md A3's notes if import-level analysis
  becomes necessary.
- **Lerna / Nx / Turborepo**: rejected — pnpm's own recursive commands and
  workspace protocol already cover Stage A's needs (topological script
  execution, workspace linking); adding a second orchestration layer isn't
  justified without a demonstrated need (e.g. remote caching at CI scale).
