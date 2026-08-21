# ADR-0002: `TypeAnalysisContext` ownership

Status: Accepted
Date: 2026-08-21

## Context

core.md §2 defines core's public API as accepting an optional `typeContext?: TypeAnalysisContext`, but explicitly deferred what that type is and who constructs it: "Whether core owns the concrete lifecycle of the TypeScript program/project service, or the caller injects it, will be decided during the Phase 0 spike." implementation-plan.md §3.1 (Spike S1) required prototyping both ownership models with running code against the `examples/playground/*.vue` fixtures before deciding, and required the decision to be reflected into core.md/analyzer.md/language-server.md as concrete API shapes — not just a yes/no answer — including: where the project service is created/shared/disposed, how unsaved SFC script content enters the type environment, and how the "TypeScript project epoch" (analyzer.md §10.1) is generated and bumped.

The spike's real code lives in `spikes/s1-decision-model/` (see `FINDINGS.md` there for the full writeup); this ADR records the decision and its consequences.

## Decision

**`TypeAnalysisContext` is caller-injected, and it is deliberately *not* a `ts.LanguageService` / `ts.server.ProjectService`.** Its shape is:

```ts
interface TypeAnalysisFs {
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
}

interface TypeAnalysisContext {
  readonly fs: TypeAnalysisFs;
  readonly epoch: number;
  /** Bumps the epoch and evicts any resolver-owned cache entries for these files. */
  invalidate(filenames: readonly string[]): void;
}
```

This decision rests on two facts established with real code (`spikes/s1-decision-model/type-analysis-context.spike.test.ts`):

1. **The cache that actually matters is process-global, not per-instance.** `@vue/compiler-sfc`'s own type-resolution cache (`fileToScopeCache`, exercised via its exported `resolveTypeElements`/`invalidateTypeCache`) is module-level state shared by the whole process, regardless of who "owns" a `TypeAnalysisContext` object. So the ownership question was never about instantiating two different caches — it's about who is responsible for keeping that one shared cache correct.
2. **That cache does no content comparison.** It trusts a filename until `invalidateTypeCache(filename)` is called. The spike proves this directly: changing an unsaved override for an imported dependency file *without* calling `invalidate()` leaves a stale resolved type domain on the very next resolution in the same process; calling `invalidate()` fixes it immediately. Only the caller (language server / analyzer / CLI) has a channel to learn that a dependency file changed — core has no independent file-watching capability (monorepo.md §3 keeps that at the host boundary) — so only the caller can correctly drive `invalidate()`.

Given that, a **core-owned** context (also prototyped, as `createCoreOwnedContext`) is strictly worse for this use case: with no per-file change signal, its `invalidate()` degrades to "bump everything," and it can never honor an open-but-unsaved *dependency* file at all — only the SFC's own content, which is already handled for free by the existing `GenerateRequest.source` parameter regardless of which model wins.

### Project-service lifecycle

There is no "project service" to create/dispose in the `ts.server` sense.
`TypeAnalysisContext` is constructed once per workspace by the caller (the
language server's `workspace/session.ts`, or the CLI for a one-shot run) and
passed on every `generateVariants` call via `GenerateRequest.typeContext`.
core never retains it between calls. Real `ts` module registration
(`registerTS(() => require("typescript"))`, needed by `@vue/compiler-sfc`'s
private resolver for cross-file resolution) happens once, at module load
time, inside core.

### Unsaved-buffer handling

- The SFC's *own* script content never goes through `fs` — it is always
  whatever `GenerateRequest.source` the caller passed for that call. This
  means "unsaved buffer" support for the file being analyzed is already
  satisfied by the existing public API shape, with no additional design
  needed.
- A *dependency* file (reached via a type-only import from the SFC's script)
  is read through `ctx.fs.readFile`. The caller's `fs` implementation
  decides whether to serve an open editor buffer's in-memory content ahead
  of disk content for that file. Both the SFC's-own-content case and the
  cross-file dependency case are proven independently in
  `type-analysis-context.spike.test.ts`.

### Project epoch definition and bump triggers

`TypeAnalysisContext.epoch` is a monotonically increasing counter, local to
one `TypeAnalysisContext` instance (one per workspace). It bumps exactly
when `invalidate(filenames)` is called, which the caller must do whenever:

- An open document's buffer changes (`didChange`) for a file that is a type
  dependency of some previously analyzed SFC (not necessarily the SFC being
  edited right now — any `.ts`/`.vue` file reachable via a type-only import
  chain).
- A file-watcher event fires for a `.ts`/`.d.ts` file that is a type
  dependency but isn't open in an editor.
- The workspace's `tsconfig.json` changes (conservatively: bump for every
  file previously resolved in that workspace, since a `tsconfig.json` change
  can alter module resolution for anything).

core's own result cache (monorepo.md §10.2, "core parse/generation" row) uses
`ctx.epoch` as (part of) its cache key, exactly as that row already
specifies ("project epoch" as an invalidation input) — this ADR fixes what
"project epoch" concretely is.

### What core builds on top, and what it reuses

core reuses `@vue/compiler-sfc`'s exported `resolveTypeElements` for
resolving the *outer* `defineProps<T>()` object shape (interface `extends`,
a `Props` type imported from another file) — this already does correct
cross-file resolution when `ctx.fs` is wired through. core adds its own
narrow resolver on top (not present in `@vue/compiler-sfc`'s public surface)
for expanding each *property's* value type into a `Domain` (core.md §4.4:
boolean, literal union via a local alias or same-directory type-only import,
array, or a documented `unsupported` fallback) — see
`spikes/s1-decision-model/prop-domain.ts` and its `FINDINGS.md` §1 for why
`resolveTypeElements` alone isn't sufficient for this. core does **not**
depend on `@vue/language-core` (the heavier package `vue-tsc`/Volar use for
full editor-grade template type-checking) — that scope was never needed for
core.md §4.4's bounded domain-derivation problem.

## Consequences

1. **Design-doc update**: core.md §2 restates `TypeAnalysisContext` with the
   concrete shape above (replacing "will be decided during the Phase 0
   spike"); core.md §4.4 gains a short note that domain resolution walks
   local type aliases and same-directory type-only imports through this
   context, falling back to `unsupported` beyond that scope, matching the
   table's existing "general string/number" and "arbitrary expression" rows.
   analyzer.md gains `typeContext` as an explicit input threaded through
   `CreateWorkspaceAnalyzerOptions`/`AnalyzeRequest` (previously absent
   despite the cache key already implying a project epoch — implementation-plan.md
   §3.1 flagged this exact gap). language-server.md's workspace session
   lifecycle (§9.1 "each workspace folder has its own ... cache") is the
   natural owner of one `TypeAnalysisContext` per workspace folder.
2. **Implementation task**: Phase 1 Step 3.4 ("TypeScript project context")
   in implementation-plan.md implements this shape for real (not spike code)
   as part of core; the epoch-keyed cache invalidation half is explicitly
   deferred to the Phase 2 Track 2 caches per that same plan section, which
   this ADR does not change.
3. **Verifying test**: `spikes/s1-decision-model/type-analysis-context.spike.test.ts`
   (6 tests) proves: cross-file resolution through both `resolveTypeElements`
   (outer shape) and the bespoke resolver (property value types), unsaved-buffer
   overrides for both the SFC's own content and a dependency file, and that
   `invalidate()` is load-bearing (a change without it stays stale; a change
   with it is picked up). The real (non-spike) Phase 1 implementation is
   required to carry equivalent tests forward per core.md §10's test list.

## Alternatives considered

- **Core-owned `ts.server.ProjectService`, fully internal**: rejected. Core
  would need its own file-watching to stay correct, which is explicitly out
  of core's scope (monorepo.md §3, "core does not know about... "); without
  file-watching, a core-owned service can only ever serve stale-or-full-rescan,
  never react to a specific unsaved dependency edit.
- **Adopt `@vue/language-core` for full template type-checking**: rejected
  for this ADR's scope. It solves a much larger problem (type-checking
  arbitrary template expressions against a virtual TS view of the whole
  component) than core.md §4.4 requires (finite-domain derivation for
  `defineProps<T>()` properties). Revisit only if core.md's domain-derivation
  ambitions grow to need real generic/conditional-type inference, which is
  explicitly out of scope today (core.md §4.4: "General string/number: A
  dummy value... Not enumerated").
- **Depend on `@vue/compiler-sfc`'s private resolver alone, accept its coarse
  `inferRuntimeType` output**: rejected — loses literal-union values
  entirely, which is core.md §4.4's primary domain-derivation case (the
  `status-literal-union.vue` fixture exists specifically to test this).
