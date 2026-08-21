# ADR-0006: Core's TypeScript type-resolution strategy

Status: Accepted
Date: 2026-08-21

## Context

ADR-0002 decided `TypeAnalysisContext`'s shape (caller-injected, thin `fs`/`epoch`/`invalidate()`) and additionally specified, in its "What core builds on top, and what it reuses" section, that core would reuse `@vue/compiler-sfc`'s exported (if `@private`-marked) `resolveTypeElements`/`registerTS`/`invalidateTypeCache` for resolving the outer `defineProps<T>()` object shape, adding only a narrow supplementary resolver for expanding each property's value type — because the Phase 0 S1 spike (`spikes/s1-decision-model/prop-domain.ts`) built and proved exactly that combination against real fixtures.

Phase 1 Step 3 (implementation-plan.md §4, "TypeScript project context") is where this gets implemented for real, non-spike code, in `packages/core/src/type-analysis.ts`. That implementation ships a different, self-contained approach instead: a resolver written entirely against the public `typescript` package API (`ts.createSourceFile`, `ts.isInterfaceDeclaration`, etc.), with no dependency on `@vue/compiler-sfc`'s private `resolveTypeElements`/`registerTS` functions at all. This diverges from ADR-0002's specific reuse plan — though not from its `TypeAnalysisContext` shape, which is unchanged and still followed exactly.

## Decision

**Core's `defineProps` type resolution (`packages/core/src/type-analysis.ts`) is a self-contained resolver built directly on the public TypeScript Compiler API — it does not call `@vue/compiler-sfc`'s `resolveTypeElements`/`registerTS`.** One resolver (`TypeResolver`) handles both the outer object shape (interface `extends`, cross-file `Props` type references) and each property's value type (literal unions, arrays, booleans, nested type aliases) uniformly, walking local type aliases and same-directory/relative type-only imports via `ts.SourceFile` inspection — exactly through ADR-0002's `TypeAnalysisFs` seam (`fileExists`/`readFile`) for cross-file reads.

This supersedes only the "what core reuses vs. builds" paragraph of ADR-0002. Its `TypeAnalysisContext` interface shape, lifecycle, unsaved-buffer handling, and project-epoch definition are all unchanged and still in effect.

Reasons, verified against the real Phase 1 implementation (`packages/core/src/type-analysis.ts`, exercised by `packages/core/src/index.test.ts`):

1. **Avoids the exact fragility ADR-0002 accepted as a tradeoff.** `resolveTypeElements` is `@private`-marked and version-coupled to `@vue/compiler-sfc`'s internals (the S1 spike's `FINDINGS.md` flagged this explicitly, accepted at the time in exchange for reuse economy on the outer shape). A resolver built only on the public `typescript` package has no such coupling.
2. **One resolver instead of two.** The spike needed `resolveTypeElements` (outer shape) *plus* a bespoke supplementary walker (property value types), because `resolveTypeElements` hands back value types unexpanded. Building directly on `ts`'s public AST types collapses this into one consistent code path — outer-shape and value-type resolution share the same logic, including the same cross-file-import handling, rather than two separately maintained mechanisms.
3. **Broader input-contract coverage for the same effort.** The shipped resolver also handles the non-generic `defineProps({ prop: Boolean })` runtime-declaration form (core.md §1's input contract) and `withDefaults(...)`, which the spike's `resolveTypeElements`-based approach did not need to cover since it only targeted the `defineProps<T>()` generic form.
4. **No loss of the S1 spike's core finding.** The reason `@vue/compiler-sfc` looked attractive in the first place — correct cross-file resolution — is preserved: the shipped resolver walks relative type-only imports through the same `TypeAnalysisFs` seam, verified by real tests, not a reduction in scope.

## Consequences

1. **Design-doc update**: core.md §2's "What core reuses vs. builds" paragraph is rewritten to describe the actual resolver (self-contained, built on the public `typescript` API, one unified resolver for outer shape + value types) instead of `resolveTypeElements` reuse. ADR-0002 gets a short pointer note at its top for this one paragraph; the rest of ADR-0002 (the `TypeAnalysisContext` shape/lifecycle/epoch decision) stands unchanged.
2. **Implementation task**: none beyond what already shipped — this ADR documents Phase 1 Step 3's actual implementation (`packages/core/src/type-analysis.ts`), already merged as part of the vertical slice.
3. **Verifying test**: `packages/core/src/index.test.ts` exercises the resolver against real `defineProps<T>()` fixtures end to end through `generateVariants` (boolean domain correlating a `v-if` and a ternary attribute through one decision; literal/array cardinality; sentinel fallback for non-finite `string` types) — these are the real, non-spike tests implementation-plan.md's Phase 1 exit criteria require.

## Alternatives considered

- **Rewrite `type-analysis.ts` to match ADR-0002 exactly (reuse `resolveTypeElements`)**: rejected. The shipped resolver is already correct, tested, and typechecked; reverting to the spike's exact approach would reintroduce the `@private`-marked dependency this decision avoids, for no coverage gain (see Decision, reasons 1–4).
- **Keep both resolvers side by side** (a `resolveTypeElements`-based path for the outer shape, the self-contained resolver only for value types): rejected. This is strictly more code, and two things to keep version-compatible with `@vue/compiler-sfc` instead of zero, for a problem the self-contained resolver already solves alone.
