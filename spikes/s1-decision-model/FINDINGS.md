# S1 findings — Decision Model feasibility (feeds ADR-0002)

Real code: `type-analysis-context.ts`, `prop-domain.ts`, `find-props-type.ts`,
`decision-collector.ts`, `expression-evaluator.ts`, plus their
`*.spike.test.ts` files (43 tests, all passing) against the three
`examples/playground/*.vue` fixtures and five additional fixtures under
`fixtures/` built specifically to exercise cross-file type resolution.

## 1. `@vue/compiler-sfc` already has a type resolver — but only half of what we need

`@vue/compiler-sfc` exports (JSDoc-tagged `@private`, i.e. not semver-covered)
`resolveTypeElements`, `registerTS`, `invalidateTypeCache`, and `inferRuntimeType`.
These are Vue's *own* internal machinery for expanding `defineProps<T>()` into
runtime prop declarations, and they already do real cross-file resolution
(`import type { X } from './y'` is followed, config-aware via `ctx.fs`).

- **`resolveTypeElements(ctx, node)`** resolves the *outer object shape*
  (interface `extends`, an entire `Props` type imported from another file)
  into a flat `{ props: { [name]: PropertySignatureNode } }` map. This is
  reusable as-is — `type-analysis-context.spike.test.ts`'s
  `imported-props-shape.vue` fixture proves cross-file resolution of the
  *whole* `defineProps<Props>()` argument works through this function alone.
- It does **not** expand each property's own *value* type. For
  `status: Status` where `Status` is a local `type Status = "a" | "b"` alias,
  `resolveTypeElements` hands back the raw `TSTypeReference` node for
  `Status`, unexpanded. Vue's own `inferRuntimeType` *does* walk further, but
  collapses the result to a coarse runtime tag (`["String"]`), which loses
  every literal value — useless for core.md §4.4's literal-union domain.

**Conclusion**: core needs a bespoke, narrow resolver for the "expand a
property's value type into a `Domain`" step (`prop-domain.ts`'s
`resolveTypeNode`), reusing `resolveTypeElements` only for the outer shape.
This is intentionally small in scope — boolean, literal union (via local
alias or a same-directory type-only import), array — matching core.md §4.4's
own bounded ambition (general string/number and anything else already falls
back to "unsupported" in the design). No dependency on `@vue/language-core`
(the much heavier package `vue-tsc`/Volar use for full template
type-checking) was needed or attempted.

## 2. The `TypeAnalysisContext` question resolves to "caller-injected, but thin"

Two concrete, surprising facts drove this:

- `@vue/compiler-sfc`'s own type cache (`fileToScopeCache`) is **process-global
  module state**, not an instantiable per-workspace object — `invalidateTypeCache(filename)`
  mutates one shared cache regardless of who calls it. So "core-owned vs.
  caller-injected" was never a choice about *two possible cache instances*;
  the cache exists exactly once per process either way.
- That cache does **no content comparison** — it trusts the filename alone
  until told otherwise. `type-analysis-context.spike.test.ts`'s last
  cross-file test proves this directly: changing an *unsaved* override for
  `props-shape.ts` without calling `invalidate()` leaves a **stale** resolved
  domain on the very next call in the same process. Calling
  `ctx.invalidate([propsShapeFile])` (which pokes both `invalidateTypeCache`
  *and* this module's own scope cache) immediately fixes it.

Given that, "who owns the project service" reduces to: **who is responsible
for calling invalidate() at the right time** — and only the caller (language
server / analyzer / CLI) has a channel to learn about `didChange`,
file-watcher events, or unsaved-buffer content for a file *other than* the
SFC currently being analyzed. Core itself has no independent way to learn a
dependency changed (monorepo.md §3 already keeps file-watching out of core's
scope). So `TypeAnalysisContext` is caller-injected, but it is **not** a
`ts.LanguageService`/`ts.server.ProjectService` — it's the much smaller
surface prototyped in `type-analysis-context.ts`:

```ts
interface TypeAnalysisContext {
  readonly fs: { fileExists(f: string): boolean; readFile(f: string): string | undefined };
  readonly epoch: number;
  invalidate(filenames: readonly string[]): void;
}
```

The SFC's own script content never goes through `fs` at all — it's always
whatever `GenerateRequest.source` the caller passed for *this* call, so
"unsaved buffer" support for the SFC itself is free by construction. `fs` is
purely the seam for *dependency* files reached via type imports, proven by
`type-analysis-context.spike.test.ts`'s override tests (both the SFC's own
content and an imported dependency's content are shown to be overridable
independently).

A core-owned context (`createCoreOwnedContext`, also prototyped) is possible
but strictly worse for this use case: it has no per-file signal, so
`invalidate()` degrades to "bump everything" and it can never react to an
open-but-unsaved dependency file at all.

## 3. Template-identifier → declaration matching needs no bespoke scope walker

Vue's own `compileScript()` already produces `BindingMetadata` (props vs.
`setup-let` vs. `setup-const` etc.), which is exactly the "which script
declaration does this template identifier refer to" answer core needs — we
reuse it (as `bindings` passed into `compileTemplate`'s
`compilerOptions.bindingMetadata`) instead of reimplementing scope analysis.
Compiling with `prefixIdentifiers: true` (required for `bindings` to have any
effect) makes every non-trivial expression a `CompoundExpressionNode`, which
has **no `content` string field at all** (only plain `SimpleExpressionNode`
does) — `decision-collector.ts`'s `sliceSource` helper reconstructs
human-readable expression text from the original template source range
instead, correcting for a real quirk found along the way: Vue sometimes
wraps an expression in `(...)` before parsing it (`extra.parenthesized`),
shifting every babel node's `start`/`end` by a constant. Subtracting the
*root* node's own `start` from any descendant's `start`/`end` cancels that
shift regardless of whether wrapping happened — a fix that would otherwise
silently mis-slice a ternary's condition by one character.

`DecisionIdentity.symbolKey` does **not** need a real `ts.Symbol` — a
`${filename}#props.${propName}` key (BindingMetadata's own binding-type
classification already discriminates `props` from `setup-let` etc.
namespacing) satisfies core.md §4.2's requirements: the same access path
always maps to the same decision, and differently-declared identifiers with
the same spelling stay distinct because the binding classification differs.

## 4. `v-if`/ternary/`v-bind` decisions correctly share identity (core.md §4.1)

`decision-collector.spike.test.ts`'s `logged-in-aria-controls.vue` case
proves the concrete example from core.md §4.1 end-to-end: `<nav v-if="props.loggedIn">`
and `:aria-controls="props.loggedIn ? 'missing' : undefined"` resolve to the
*identical* `DecisionIdentity` (same `symbolKey`, same `accessPath`), which is
the precondition for evaluating both under one shared `VariantEnvironment`.

## 5. Expression evaluator (core.md §4.6) — the grammar table is a runnable fixture

`expression-evaluator.ts` implements literals/identifiers/property
access/parens, `!`, `===`/`!==`/`==`/`!=` (restricted to literal-or-null per
the design doc — comparing two decisions to each other is explicitly
unsupported and verified to return `unknown`), `&&`/`||`/`??`, ternary, and
optional chaining, plus the "predicate decision" promotion
(`isSideEffectFree` + `normalizePredicateKey`, with `!x` correlating to `x`'s
own key negated) and the "unknown fallback" rule (`unknownFallback`, IF always
generates both branches, `v-bind` prefers a finite-union static domain over a
dummy value). All 28 rows in
`expression-evaluation-table.spike.test.ts` pass against real parsed
expressions (via `@vue/compiler-sfc`'s `babelParse`), including ones pulled
directly from the example fixtures (`props.items.length > 0`,
`props.status === 'active'`).

## 6. `v-for` node type constant correction

Found and fixed a real bug during this spike, worth flagging since it would
recur for anyone hand-rolling a template walker against `@vue/compiler-core`:
`NodeTypes.IF_BRANCH = 10` and `NodeTypes.FOR = 11` — NOT `10` for FOR as a
naive reading of "IF=9, FOR is the next structural node type=10" would
suggest. Import the real `NodeTypes` enum from `@vue/compiler-core` rather
than hand-coding numeric constants.
