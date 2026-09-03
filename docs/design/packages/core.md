# `vue-html-bridge` (core) Design

Status: Implemented  
Package directory: `packages/core`  
Package name: `vue-html-bridge`

## 1. Role

Parse the source of a Vue 3 SFC and generate the static HTML variants that the `<template>` can produce, together with the mapping/provenance needed to trace the generated HTML back to the source.

This package is the core of the bridge, as its name suggests. However, it does not judge HTML validity itself.

### In scope

- SFC parsing and extraction of `<template>`
- Linking the template/compiler AST with information from the script and types
- Collecting the expressions that affect variants, and building the Decision Model
- Preserving correlation by evaluating the whole template under one shared `VariantEnvironment`
- Direct serialization from the Vue AST to static HTML strings
- Mapping and provenance between source and generated ranges
- Core diagnostics/stats for unsupported syntax, unresolvable types, variant count, etc.

### Out of scope

- Running Markuplint (or similar) and discovering its configuration
- Aggregating validator diagnostics
- LSP protocol, line/column conversion, editor lifecycle
- Import resolution and template inlining for child components
- Running the Vue app at runtime

### Input contract

| Input                                                                                             | Handling                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<template lang>` set to something other than the default (e.g. pug), or `<template src>`         | Reported as a diagnostic; no variants are generated                                                                                                            |
| No `<script>` block                                                                               | The template is processed. Falls back to a dummy value with no type information                                                                                |
| `<script src>`, `<script lang="ts">` without `<script setup>`, or a plain `<script>` (JavaScript) | The template is processed. Binding type resolution falls back to a dummy value and is reported as a diagnostic. The Options API `this` context is not resolved |
| `lang="tsx"`                                                                                      | Treated as TypeScript                                                                                                                                          |
| Custom delimiters, Vue 2 compatibility syntax                                                     | Out of scope. Delimiters cannot be detected from the SFC alone, so the default delimiters are always assumed                                                   |

## 2. Public API

The public API is async. The core's own processing (compiler, TypeScript) is CPU-bound synchronous work, but running it as a synchronous API inside the single-threaded LSP process would block the event loop — during that time, the process could not receive `didChange` notifications or observe an `AbortSignal` firing. To avoid this, we place yield points at phase and environment boundaries that return control to the event loop, and check the signal at each one. The delay before cancellation takes effect is bounded by the longest synchronous segment (for example, resolving the type of a single expression). The Phase 0 spike (S4) measured this against representative fixtures and found the 100ms budget met by 2–3 orders of magnitude (ADR-0005); the internal implementation stays synchronous, in-process. This is re-measured, not assumed, at the Phase 1 and Phase 2 performance gates (implementation-plan.md §4, §5) — the public API stays async specifically so a later move to a worker thread, if ever needed, would not change it.

```ts
export interface GenerateRequest {
  filename: string;
  source: string;
  options?: GenerateOptions;
  typeContext?: TypeAnalysisContext;
  signal?: AbortSignal;
}

export interface GenerateResult {
  variants: readonly HtmlVariant[];
  diagnostics: readonly CoreDiagnostic[];
  stats: GenerationStats;
  templateRange?: SourceRange;
}

export function generateVariants(
  request: GenerateRequest,
): Promise<GenerateResult>;
```

`TypeAnalysisContext` is **caller-injected** (ADR-0002). It is deliberately not a `ts.LanguageService` / `ts.server.ProjectService` — only the caller (language server / analyzer / CLI) has a channel to learn that a dependency file changed (core has no file-watching capability — §1, monorepo.md §3), so only the caller can correctly drive invalidation via `epoch`. core's own type resolution (ADR-0006) does no internal caching today — it re-resolves from `ctx.fs` on every call — so `epoch` currently exists to serve as (part of) the *caller's* result-cache key (monorepo.md §10.2, Phase 2 Track 2), not to invalidate a cache inside core itself. The shape is:

```ts
export interface TypeAnalysisFs {
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
}

export interface TypeAnalysisContext {
  readonly fs: TypeAnalysisFs;
  readonly epoch: number;
  /** Bumps the epoch and evicts any resolver-owned cache entries for these files. */
  invalidate(filenames: readonly string[]): void;
}
```

- **Lifecycle**: constructed once per workspace by the caller (one per workspace folder in the language server; one per run in the CLI) and passed on every `generateVariants` call via `GenerateRequest.typeContext`. core never retains it between calls.
- **Unsaved buffers**: the SFC's own script content never goes through `fs` — it is always whatever `GenerateRequest.source` the caller passed for that call, so unsaved-buffer support for the file being analyzed is free by construction. A *dependency* file reached via a type-only import is read through `ctx.fs.readFile`, letting the caller serve an open editor buffer's content ahead of disk content for that file too.
- **Project epoch**: `epoch` is a monotonic counter, local to one `TypeAnalysisContext` instance, that bumps exactly when `invalidate(filenames)` is called. The caller must call it whenever an open document's buffer changes for a file that is a type dependency of some previously analyzed SFC, a file-watcher event fires for a non-open type-dependency file, or the workspace's `tsconfig.json` changes (conservatively: bump for every previously resolved file). `epoch` is the "project epoch" referenced by core's own result cache key (monorepo.md §10.2).
- **What core reuses vs. builds** (ADR-0006, superseding this paragraph's earlier `resolveTypeElements`-reuse plan from ADR-0002): core resolves `defineProps` types with a self-contained resolver built directly on the public `typescript` package API — it does not call `@vue/compiler-sfc`'s private `resolveTypeElements`/`registerTS`. One resolver handles both the *outer* object shape (interface `extends`, a cross-file `Props` type reference) and each property's *value* type (boolean, literal union via a local alias or same-directory/relative type-only import, array, or `unsupported`) uniformly, reading cross-file dependencies through `ctx.fs` exactly as `TypeAnalysisFs` prescribes. This avoids depending on `@vue/compiler-sfc`'s `@private`-marked, version-coupled internals, and — since nothing hands back unexpanded value types the way `resolveTypeElements` does — needs only one code path instead of two. It also covers the non-generic `defineProps({ prop: Boolean })` runtime-declaration form and `withDefaults(...)`. core does not depend on `@vue/language-core` (the heavier package `vue-tsc`/Volar use for full template type-checking) — full generic/conditional-type inference is out of scope, matching this section's "general string/number" and "unevaluable expression" fallback rows.

Type analysis only reads the tsconfig and type definition files as data; it does not load TypeScript/Vue language service plugins or custom transformers. This holds regardless of the workspace trust state — type analysis itself never involves running arbitrary code (language-server.md §10).

### 2.1 Generation options

```ts
export interface GenerateOptions {
  warnVariantCount?: number; // default: 256. Warning only, does not stop generation
  /**
   * Tags to emit as native elements (Web Components), instead of treating them as components.
   * A tag name or a glob (e.g. "ion-*"). Functions are not accepted.
   */
  customElements?: readonly string[];
  /** Declares which attributes a custom directive sets, and how to derive each value (§5.3.1). */
  customDirectives?: readonly CustomDirectiveMapping[];
}

export interface CustomDirectiveMapping {
  /** Directive name w/o "v-", e.g. "src", "imgAttr"; matched camelized (§5.3.1). */
  readonly name: string;
  /** attrName -> value template (§5.3.1). */
  readonly attributes: Readonly<Record<string, string>>;
}
```

`customElements` is not a function (unlike Vue's `isCustomElement`) because a function cannot be normalized into a cache key, and cannot be passed through JSON-based LSP settings either. The public contract is that `GenerateOptions` as a whole consists only of JSON-compatible values, so that the normalized result can be used directly as the cache key for the core result cache. `customDirectives` keeps this contract: every value template is a plain string, so the whole option stays trivially JSON-serializable and cache-key-safe. The analyzer's result-cache key normalizer sorts `customDirectives` (both the entry order and each entry's own attribute-key order) before hashing, exactly like `customElements` (analyzer.md §10.1) — this is sound, not just deterministic, because core rejects any two entries that collide on their camelized name outright (§5.3.1), so there is never a wins-rule an order-insensitive key could conflate two differently-behaving options objects under.

The initial version has no hard limit. It measures count and time and issues a warning; the need for a limit will be decided after we have real data.

Comments are always stripped. This is not made an option, because character references are not interpreted inside HTML comments, and there is no way to reconcile comments that contain newlines with the strict one-line serialization contract (§2.2). If this need arises later, it will be reconsidered together with a spec for how to represent newlines inside comments.

Decision metadata (`HtmlVariant.decisions`, `MappingEntry.provenance`) is always included. It is not an option, because the analyzer's evidence display and provenance normalization depend on it.

### 2.2 Variant

```ts
export interface HtmlVariant {
  id: string;
  ordinal: number;
  html: string;
  decisions: readonly DecisionAssignment[];
  map: readonly MappingEntry[];
}

export interface DecisionAssignment {
  decisionId: string;
  displayName: string;
  value: JsonValue;
}
```

- `html` is a static HTML fragment. It contains no Vue directives, component tags, or bridge-internal `data-*` attributes. It does not implicitly add `html` / `head` / `body`.
- Each variant is always serialized onto a single line. The adapter's range conversion and the analyzer's reverse mapping both depend on this contract. Newlines inside source attribute values are escaped to `&#10;` so range calculations stay correct.
- `id` and the enumeration order are deterministic for the same input, options, and core version.
- Variants that share the same HTML can be shared when adapters run them, but core never discards decision evidence.

## 3. Processing pipeline

```text
parseSfc
  -> compileTemplate AST
  -> collect reachable expressions
  -> resolve symbols/types/access paths
  -> build DecisionModel + ExpressionPlan
  -> enumerate VariantEnvironment
  -> evaluate whole template under each environment
  -> serialize HtmlFragment + mappings
  -> emit variants, diagnostics, stats
```

We do not use a DOM implementation (such as happy-dom) as an intermediate representation. A DOM parser/serializer normalizes attribute names, namespaces, void elements, SVG casing, and so on, which would break the position correspondence with the SFC source. Instead, we go from the compiler AST through a small, bridge-specific HTML fragment IR, and stringify directly from there.

## 4. Decision Model

### 4.1 Don't create independent variants per node

If separate nodes that reference the same state are expanded independently, the result can be HTML that would never occur at runtime.

```vue
<nav v-if="loggedIn" id="user-menu" />
<button :aria-controls="loggedIn ? 'user-menu' : undefined" />
```

If `nav` and `button` are expanded independently and combined as a cross product, we get a contradictory variant where "`nav` is absent but `aria-controls=user-menu`". Instead, core collects the expressions relevant to variants from the template and script, and treats the shared state atom `loggedIn` as a single decision.

```ts
type DecisionId = string;

interface Decision<T extends JsonValue = JsonValue> {
  id: DecisionId;
  identity: DecisionIdentity;
  domain: readonly T[];
}

interface VariantEnvironment {
  get<T extends JsonValue>(decisionId: DecisionId): T;
}
```

Within one environment, every AST node reads the same `loggedIn` value. The example above then produces only these two variants:

```html
<!-- loggedIn = true -->
<nav id="user-menu"></nav>
<button aria-controls="user-menu"></button>

<!-- loggedIn = false -->
<button></button>
```

This does not require changing how the SFC is written to suit the bridge.

Preserving correlation is a requirement of the final state. In Phase 1 (monorepo.md §14), we temporarily accept the over-approximation caused by treating decisions independently per node (which lets contradictory variants slip in); the global Decision Model is introduced in Phase 2.

### 4.2 Decision identity

A value decision is not identified by its expression string alone — it is identified by the TypeScript symbol and the access path.

```ts
interface DecisionIdentity {
  symbolKey: string;
  accessPath: readonly (string | number)[];
  templateScopeId?: string;
}
```

- The same `props.state.kind` always refers to the same decision.
- Variables with the same spelling but different declarations are different decisions.
- For a `v-for` alias, the FOR node's source range is included in `templateScopeId`, keeping it separate from an outer variable with the same name.
- We do not treat semantic aliases, arbitrary function return values, or getters with side effects as equivalent.

### 4.3 Expressions we collect

We perform a DFS limited to the region reachable in renderer output, and collect:

- The `condition` of `IF_BRANCH`
- The expression of `v-bind` / `v-model`
- The source, alias, and cardinality of `v-for`
- The state of the corresponding built-in components
- Values that affect serialization, such as a form control's `type`

We do not enumerate every possible value of interpolated text — it becomes `dummy-string` instead, and is therefore not turned into a decision. We also do not descend into unrendered custom components, normal slots, or the children of `v-html`.

### 4.4 Domain

We derive a finite domain from types and expressions.

| Input                                                     | Domain / behavior                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `boolean`                                                 | `true`, `false`                                                                   |
| string/number literal union                               | All literals                                                                      |
| Finite union + `null`/`undefined`                         | The literals, plus "attribute absent"                                             |
| Ternary expression                                        | An `ExpressionPlan` that links the condition decision to the value of each branch |
| `v-if`/`v-else-if`/`v-else`                               | Evaluated as mutually exclusive under the same environment                        |
| General `string` / `number`                               | A dummy value matching the type. Not enumerated as a finite set                   |
| Arbitrary function calls or expressions with side effects | An unevaluable diagnostic plus a conservative fallback                            |

We do more than just take the cross product of type domains — each expression is evaluated as an `ExpressionPlan` that refers to shared decisions. Obvious path constraints may be pruned either before enumeration or during evaluation, but if pruning would change completeness, it must still be recorded in a diagnostic/stat.

### 4.5 `v-for`

When the symbol/access path of the `v-for` source can be resolved, we add a `collection-cardinality` decision per collection identity, and generate 0, 1, and 2 items. Iterables that cannot be resolved, or results of functions such as filter/map, fall back to a `for-count` decision local to that FOR node.

- 0 items: detects problems where a required child element is missing.
- 1 item: verifies the usual exemplar case.
- 2 items: renders the same exemplar twice, to detect issues such as duplicate static `id`s.

The 2-item case is a duplicate of the same exemplar; the initial model does not cover per-row combinations of different values. Problems that only appear with three or more items are also out of scope.

Note that the earlier design (Rev. 8 of the root document) made for-count local to each FOR node and did not correlate it with length predicates. See decision-changes.md for why this version instead correlates for-count with length predicates, limited to the same collection identity.

Another FOR that references the same collection identity, and any `items.length` predicate the bridge can interpret, refer to the same cardinality decision. For example, `items.length === 0`, `items.length > 0`, `items.length === 1`, and `items.length > 1` are all evaluated using the 0/1/2 representative values, so we never generate a variant that contradicts the FOR's item count. A predicate that can only be evaluated by distinguishing three or more items, such as `items.length > 2`, is treated as unsupported and falls back conservatively, with a diagnostic. We never assume that `filteredItems`, `getItems()`, `items.filter(...)`, and similar expressions have the same item count as the original collection.

### 4.6 Expression evaluation rules

Under each `VariantEnvironment`, we **do not execute** expressions — we only interpret the following side-effect-free subset (ported from §9.4 of the earlier design, Rev. 8):

- Literals, identifiers, resolved property access, parentheses
- `!`
- `===` / `!==`, and `==` / `!=` against a literal or `null`
- `&&` / `||` / `??`
- The ternary operator
- Optional chaining on a supported expression

```ts
type EvaluationResult<T> =
  | { kind: "known"; value: T }
  | { kind: "unknown"; reason: string };
```

We do not evaluate function calls, constructor calls, assignment/update expressions, `await`, accesses that require running a getter, or unsupported operators. Static analysis must never call things like `checkPermission()` or `Math.random()`.

**Predicate decision:** Even for an operator the corresponding evaluator cannot compute, if the whole expression can be judged as a side-effect-free boolean condition (for example, `count > 0` on a non-finite `number`), we abstract its truthiness into an auxiliary decision with domain `[true, false]`. We only correlate the same normalized expression within the same scope, and its simple negation (`!x`). We do not infer logical relationships between different predicates (for example, the implication between `count > 0` and `count > 1`). We do not create a predicate decision for expressions that can already be evaluated using value decisions alone.

**Unknown fallback (unified rule):**

- IF: generate both "this branch is taken" and "control proceeds to the next branch" locally.
- `v-bind` / `v-model`: if the whole expression's type can be resolved to a finite union, generate only those candidates locally. If that is not possible either, fall back to a type-appropriate dummy value plus an `expression-not-symbolically-evaluable` **hint**-severity diagnostic.
- Multiple occurrences of the same unevaluable expression are, in principle, not correlated with each other, since a function call (for example) is not guaranteed to return the same result each time. Only side-effect-free boolean expressions can be promoted to a predicate decision.

Unevaluable-expression diagnostics are not added redundantly per environment by the renderer. When the Decision Model is built, we record one entry per expression, keyed by "diagnostic code + source range of the template expression". Only the rendered result of the local fallback varies per environment.

The Phase 0 spike (S1) fixed the complete grammar → evaluator mapping as a runnable fixture (`spikes/s1-decision-model/expression-evaluator.ts`, exercised by 28 passing cases in `expression-evaluation-table.spike.test.ts` against real parsed expressions, including some pulled directly from this repo's example fixtures):

| Grammar shape | Evaluator behavior |
| --- | --- |
| String/numeric/boolean/`null` literal | `known(value)` |
| `undefined` identifier | `known(undefined)` |
| Identifier / non-computed property access resolving to a decision | Looks up the decision's assigned value in the current `VariantEnvironment`; `unknown` if the access path isn't a registered decision |
| Parentheses | Transparent — evaluates the inner expression (no distinct AST handling needed; a parser may reparse a wrapped source substring with an offset that must be corrected back against the original range, see core.md §7's mapping fixture) |
| `!x` | `known(!v)` if `x` evaluates to `known(v)`, else propagates `x`'s `unknown` |
| `===` / `!==` / `==` / `!=` | Supported **only** when at least one operand is a literal or `null` (comparing two decisions to each other is `unknown` — not supported); evaluates both sides and applies the matching JS equality semantics |
| `&&` / `||` / `??` | Standard short-circuit semantics: `&&`/`||` on the left operand's truthiness, `??` on nullishness; the right side is only evaluated when short-circuiting doesn't apply; `unknown` on the left propagates immediately |
| Ternary | Evaluates `test`; if `known`, evaluates the matching branch; if `unknown`, the whole expression is `unknown` (an `ExpressionPlan` links the condition decision to each branch's value — see §4.4) |
| Optional chaining (`?.`) on a supported expression | Resolved the same as non-optional property access once reduced to an access path |
| Function/constructor calls, assignment/update, `await`, unsupported operators (e.g. `>`, `<`) | Always `unknown` — never evaluated, even when the call looks side-effect-free |

**Predicate-decision eligibility** (`isSideEffectFree`) walks the same node kinds the evaluator supports (literals, identifiers, non-computed property access, `!`, binary/logical/ternary composed from those) — a `CallExpression` anywhere in the tree makes the whole expression ineligible, even nested inside an otherwise-supported shape (e.g. `checkPermission() > 0` is never promoted). Predicate correlation keys are the expression's own AST with source positions stripped (so two occurrences of the identical expression share a key), and `!x` normalizes to the same key as `x` with a negated flag — confirmed distinct from a different comparison on the same identifier (`count > 0` and `count > 1` do **not** share a key).

## 5. Vue AST transformation policy

### 5.1 Native elements and `<template>`

- A native element emits its tag, static attributes, evaluated dynamic attributes, and children.
- `<template>` emits its children without a wrapper.
- `v-if` and similar directives are handled through the IF/FOR nodes the compiler already structures.
- An `is` attribute on a native element is emitted as the real attribute of a customized built-in element. An `is` with the `vue:` prefix designates a component, and is treated as one.
- Comments are stripped (§2.1).

### 5.2 Components and slots

- A custom component itself, and its children, are not emitted.
- A tag matching `GenerateOptions.customElements` (Web Components) is emitted as a native element, not treated as a component.
- `<slot>` itself is never emitted as an element, regardless of whether it is empty. An empty `<slot>` (no children, or fallback content that itself produces no output — e.g. only whitespace or comments) continues to emit nothing. Non-empty fallback content replaces the `<slot>` element and is evaluated like any other template children at that position — the same v-if/v-for/directive/diagnostic handling as everywhere else, with no `<slot>`-specific special-casing of the content itself. (Unlike `Transition`/`Teleport`'s `#default`-template unwrapping below, a `<slot>`'s children are already its fallback content directly — there is no template-wrapper convention to unwrap.)
- Slot content written by the consumer is not emitted either.
- As a result, the content model across a component boundary is not verified.

Vue built-ins only get explicit special-case handling:

- `Transition` / `Teleport`: emit their normal children, or the children of a direct `#default`, without a wrapper.
- `TransitionGroup`: if it has a static `tag`, use it as a wrapper; otherwise unwrap. A dynamic `:tag` is reported as a diagnostic and unwrapped.
- `Suspense`: expand `default` and `fallback` as mutually exclusive decisions.
- An unsupported named slot is not emitted, and is reported as a diagnostic.

`v-slot` is recognized, before component processing runs, on the reachable path of a direct `<template>` under a component or built-in. This avoids it being mistakenly handled by the generic `<template>` unwrap logic.

### 5.3 Directives

| Syntax                                  | Initial behavior                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `v-bind:name`                           | Evaluate the expression and emit either the attribute or no attribute                                                     |
| `v-bind="obj"`                          | Expand only if the static keys/values can be resolved to a finite set. Otherwise, report a diagnostic and exclude it      |
| Dynamic argument `:[name]`              | Expand only if the name/value can be resolved to a finite set. Otherwise, report a diagnostic and exclude it              |
| `v-on`                                  | Converted to `on{event}="dummy-fn"`, as input for A11y rules                                                              |
| `v-model`                               | Converted to `value`/`checked`/etc. depending on the element/type. For `<select>`, does not emit `selected` on the option |
| `v-show`, `v-once`, `v-memo`, `v-cloak` | Directive is removed and rendering proceeds normally                                                                      |
| `v-text`                                | Children are replaced with `dummy-string`                                                                                 |
| `v-html`                                | Directive and children are excluded, and a diagnostic is reported                                                         |
| Custom directive                        | Directive is removed, with a diagnostic noting that DOM/attribute side effects are not modeled — **unless** a `GenerateOptions.customDirectives` entry declares its attributes (§5.3.1), in which case those attributes are emitted instead |
| `v-pre`                                 | The subtree the Vue compiler treats as literal is emitted statically                                                      |

Event modifiers are reduced to the base event; modifiers such as `.capture` / `.once` / `.passive` do not affect the HTML attribute name. Cases that need Vue runtime semantics, such as the event-name conversion for `.right` / `.middle`, are pinned down with fixtures.

Handling of `v-bind` modifiers: `.prop` and the `.` shorthand bind to a DOM property and do not emit an HTML attribute. `.camel` camelizes the attribute name. `.attr` emits a normal attribute. The Vue 3.4 same-name shorthand (`:value`) is treated as a normal `v-bind`.

### 5.3.1 Custom-directive attribute value modeling

`GenerateOptions.customDirectives` (ADR-0010) lets a caller declare, per custom directive, which attributes it sets and how to derive each value from the directive's bound expression — closing the false-positive class where a directive like `v-src="assetUrl(...)"` sets `src` at runtime (`el.setAttribute` in `mounted`/`updated`, or a `getSSRProps` hook) that core can never statically read. **A declared mapping is an unverified assertion about the directive's real behavior** — core can never execute the directive's own implementation, only the bound expression written in the template — so a wrong or stale declaration can turn a real, safe-by-default warning into a false negative (the same trust framing ADR-0008 applies to external adapters, here applied to declarative config instead of executable code).

**Matching.** A declared `name` and a template's directive name are both camelized before comparison (the same `-([a-z])` → uppercase idiom the `.camel` `v-bind` modifier uses), mirroring Vue's own `resolveDirective` — so `v-img-attr` and `v-imgAttr` in the template both reach one mapping declared as `imgAttr` or `img-attr`. A usage that carries an argument (`v-src:foo="x"`) still matches by name; the argument is ignored. `$arg` and `$modifiers` cannot be referenced by a value template at all in v1 — a known limitation, not a bug (§11).

**Value templates.** Each declared attribute's value template is one of exactly two shapes, chosen so the directive's bound expression only ever needs to be evaluated once, through the same side-effect-free evaluator §4.6 already defines — reusing an *evaluated value*, not re-running text substituted back through the evaluator (which the expression grammar's property-access handling cannot support: `accessPath` requires the whole chain to bottom out at a resolvable identifier, so it can never index into an already-evaluated sub-result):

- A **literal string constant** — a template containing no `$value` token — is emitted verbatim as the attribute's value and is **never parsed as an expression**. `"role": "status"` means the literal string `status`, not a reference to a `status` binding; this also means a bare word like `status`/`polite`/`img` — the most common shape of attribute value — just works, with no quoting-inside-JSON ever required.
- **`$value`**, optionally followed by dotted property segments (`$value`, `$value.src`, `$value.a.b`), resolves by plain, **own-properties-only** lookup on the directive's bound expression, evaluated once and shared across every attribute declared for that directive occurrence. A missing key (present-but-`undefined`, or the whole path found but the key absent) resolves to "no value" and the attribute is silently dropped, exactly like `v-bind`'s existing undefined-drop rule — this is usually the symptom of a stale declaration, so watch for a `customDirectives` mapping whose keys no longer match the directive's actual runtime shape. A **structural mismatch** (indexing into a string, array, `null`, or a value that failed to evaluate at all) instead takes the sentinel path below. `$value.constructor` / `$value.toString` / `$value.__proto__` and similar prototype properties are never resolved — only the value's own properties are visible to a lookup, so these behave exactly like a missing key.

Multi-attribute fan-out from one bound object expression (e.g. one `v-imgAttr="{ src, height }"` declaring both `src: "$value.src"` and `height: "$value.height"`) evaluates the bound expression exactly once and looks up each attribute's path independently — this is what makes fan-out strictly more capable than a hypothetical existence-only design that could only assert attribute *names*, not values.

**Provenance.** A constant attribute always carries `source-literal` provenance anchored at the directive usage — it is asserted to be the real rendered value, so a validator finding against it (e.g. an invalid `role` value) must anchor there and flow through analyzer's provenance normalization exactly like a real static attribute, not be suppressed as synthetic. A `$value`-path attribute reuses the directive's own bound-expression node as its provenance source (mirroring how `v-bind="obj"`'s existing no-arg fan-out reuses one expression node for every key), so its `sourceRange` and provenance (`finite-domain` when the bound expression references a decision-bound binding, `source-literal` otherwise) point at the real directive usage. One accepted imprecision, inherited directly from `v-bind="obj"`'s existing behavior: if the bound expression references a decision-bound identifier, **every** fanned-out `$value`-path attribute inherits that `finite-domain` provenance, even ones that don't actually depend on the specific fanned path — documented, not fixed. This imprecision is scoped to `$value`-path attributes only; a constant attribute in the same mapping never inherits it, since it never depends on the bound expression at all.

**Decision collection.** A directive whose mapping contains at least one `$value`-path template participates in decision collection exactly like `v-bind`/`v-model`: a decision-bound identifier referenced by its bound expression registers a decision, so branching through the directive's value produces correctly correlated variants instead of silently collapsing to one. An **all-constant** mapping deliberately does **not** register a decision for its bound expression (it never evaluates it, so an unused decision would only multiply variants with identical HTML).

**Unresolvable values.** When the bound expression cannot be evaluated to a known value at all — most commonly because it contains a function call, which is outside the evaluator's side-effect-free subset (§4.6) — every `$value`-path attribute for that directive occurrence falls back to a placeholder value (via the same dummy-value rules as an unresolvable `v-bind`) plus one `custom-directive-value-unresolved` **info**-severity diagnostic per attribute. This is a permanent, inherent limitation, not a bug: `v-src="computeUrl(name)"` — and, tellingly, `assetUrl(...)` *inside* the real `vSrc` directive's own implementation, which core never reads at all — both fall to this path. A directive occurrence with no bound expression at all behaves the same way for any `$value`-path attribute in its mapping (an all-constant mapping is unaffected, since it never touches the bound expression).

**Diagnostics.** `custom-directive-mapping-invalid` (**warning**, anchored at the template range) covers defensive, core-side re-validation of a `customDirectives` entry: an invalid attribute-name key, a malformed `$value`-containing value template (one that contains the text `$value` but does not match the dotted-path grammar above — dropped at parse time, so it never reaches rendering), a `name` that names a reserved built-in/control directive (`bind`, `on`, `model`, `text`, `html`, `slot`, `pre`, `if`, `else-if`, `else`, `for`, `show`, `once`, `memo`, `cloak` — such a mapping could never be reached by the dispatch order above it anyway), or two-or-more entries colliding on their camelized name (**all** colliding entries are dropped — there is no wins-rule, since a wins-rule would be array-order-dependent while the cache key normalizer sorts entries, and `[A, B]` vs. `[B, A]` must never hash to the same key while keeping different winning semantics). Settings-file validation (settings.md §3.1) is the primary surface for these problems, with per-field error messages at config-load time; this defensive re-check exists because a caller can invoke core's API directly, bypassing settings entirely. `custom-directive-value-unresolved` (**info**) is the per-attribute unresolvable-value diagnostic described above.

Out of scope for v1: `$arg`/`$modifiers` substitution in value templates; a CLI flag (config-file only, cli.md §4.2); unified attribute-write conflict resolution across static/`v-bind`/`v-model`/custom-directive writers to the same attribute name; a `$$value` escape for a constant that needs to contain the literal text `$value`. See ADR-0010 for the full rationale and alternatives considered.

The Vue-specific attributes `key`, `ref`, `true-value`, and `false-value` are never emitted to HTML. If a static `value` / `checked` conflicts with the output of `v-model`, `v-model` takes priority, and a diagnostic is reported.

### 5.4 Dummy values and sentinels

A value that cannot be narrowed to a finite set is converted into a representative value chosen for validity, based on the type, element, and attribute.

```ts
type GeneratedValueProvenance =
  | { kind: "source-literal"; sourceRange: SourceRange }
  | { kind: "finite-domain"; sourceRange: SourceRange; decisionId: string }
  | {
      kind: "synthetic";
      sourceRange: SourceRange;
      transformation: "vue-event" | "v-model" | "text-placeholder";
    }
  | {
      kind: "sentinel";
      sourceRange: SourceRange;
      reason: "non-finite-type" | "unresolved-expression";
      originalType?: string;
    };
```

Here, a sentinel is a known stand-in value (for example, `dummy-string`) inserted to let analysis continue, rather than real data. `synthetic` is a transformation used to represent Vue semantics as validator input — for example, turning `@click` into `onclick="dummy-fn"`. Provenance records whether a generated fragment comes from a source literal, a decision, a synthetic transformation, or a sentinel.

Example:

```vue
<button :aria-pressed="value" />
```

If all we know is `value: string`, we generate:

```html
<button aria-pressed="dummy-string"></button>
```

The mapping for `dummy-string` carries `kind: "sentinel"` and the range of the original `value`. This lets the analyzer downstream replace Markuplint's surface-level diagnostic ("the value of `aria-pressed` is invalid") with a bridge-specific diagnostic — "this attribute value cannot be narrowed to a finite set." This avoids the misunderstanding that the sentinel itself is a real value, while still encouraging the developer to narrow the type toward a literal union.

For form values, where a dummy value could trigger a different false error, we use a type-appropriate value instead — for example, `dummy@example.com` for `input[type=email]`, or `1` for a number. This mapping table is managed in one place in the implementation, and pinned down with snapshot tests.

## 6. Serialization

### 6.1 Fragment IR

```ts
type HtmlFragment = ElementFragment | TextFragment | RawStaticFragment;

interface ElementFragment {
  kind: "element";
  tagName: string;
  attributes: readonly AttributeFragment[];
  children: readonly HtmlFragment[];
  sourceRange: SourceRange;
}
```

The Fragment IR is not part of the public API. It keeps the shape of the Vue compiler AST from leaking to adapters, and limits the serializer's input to the minimal elements of static HTML.

### 6.2 Escaping and HTML semantics

- In text, `&` and `<` are escaped.
- Newlines (LF / CRLF) inside a text node are normalized to a single space by whitespace condensing. Elements where newlines are meaningful, such as `<pre>` / `<textarea>`, lose their newlines as a result (§11).
- Inside a quoted attribute value, `&`, `"`, U+000A, and similar characters are escaped.
- A mapping entry always targets the generated range after transformation and escaping. The source-to-generated transformation (escaping, newline normalization, character-reference conversion) and the rules for splitting mapping entries are pinned down by golden tests (§10).
- For a boolean attribute, `true` emits just the attribute name; `false`/`null`/`undefined` emits no attribute.
- Void elements get no end tag; all other elements get an explicit end tag.
- Tag/attribute casing is preserved for both the HTML namespace and the SVG/MathML namespaces.
- Source whitespace formatting is not reproduced — we generate deterministic, compact HTML instead.

## 7. Mapping and provenance

```ts
export interface MappingEntry {
  generated: GeneratedRange;
  source: SourceRange;
  kind: "element-name" | "attribute-name" | "attribute-value" | "text";
  provenance: GeneratedValueProvenance;
}

export interface SourceRange extends OffsetRange {
  filename: string;
}

export interface GeneratedRange extends OffsetRange {}
```

`OffsetRange` (monorepo.md §6.1) and `JsonValue` are defined structurally within this package. We do not share the type declarations of the structurally identical types in validator-api across packages; agreement between them is instead verified by a contract test (a counterpart to validator-api §2).

### 7.1 Requirements

- Create an entry for every native element name, every static/dynamic attribute name and value, and every piece of source-derived text.
- `source` is a UTF-16 absolute offset into the whole `.vue` file.
- `generated` is a UTF-16 absolute offset into the variant's `html`.
- Entries are ordered deterministically by `generated.start`, then range length, then `source.start`.
- A single generated range may have multiple entries. We do not collapse a composed `class` / `style`, an event, a sentinel, and similar cases down to one source.

### 7.2 Reverse-lookup helper

```ts
export interface SourceOrigin {
  entry: MappingEntry;
  /** The number of code units where the requested generated range and entry.generated overlap, in a reverse lookup. */
  overlap: number;
}

export function findSourceOrigins(
  map: readonly MappingEntry[],
  generatedRange: GeneratedRange,
): readonly SourceOrigin[];
```

1. Collect entries that intersect the diagnostic range.
2. Prefer entries with a larger intersection, or with the smallest containing range.
3. If multiple entries tie on specificity, return all of them.
4. If nothing is found, return an empty array. The analyzer decides how to apply the template fallback.

**Handling of a zero-width range:** `[p, p)` has no positive intersection with any entry, so it is treated as a point query instead.

- Collect entries that satisfy `generated.start <= p < generated.end` (entries that contain p), with `overlap` set to 0.
- If multiple containing entries exist, prefer the shortest generated range (the innermost one).
- If p is not inside any entry and only coincides with a boundary (for example, `p === generated.end` while the next entry has `start === p`), prefer the entry that ends at p; if there is none, return the entry that starts at p.
- At EOF (`p === html.length`), if no matching entry exists, return an empty array and leave it to the analyzer's template fallback.

Core never commits to a single source location. Choosing primary vs. related locations, and aggregating across variants, is the analyzer's responsibility.

## 8. Core diagnostics and stats

```ts
export interface CoreDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  sourceRange: SourceRange;
  relatedRanges?: readonly SourceRange[];
}

export interface GenerationStats {
  decisionCount: number;
  candidateCount: number;
  emittedCount: number;
  uniqueHtmlCount: number;
  durationMs: number;
  warningThresholdExceeded: boolean;
}
```

We do not duplicate an unevaluable-expression diagnostic for the same expression across every variant — it is consolidated into a single entry, keyed by `code + sourceRange`, when the Decision Model is built. Exceeding the variant threshold returns a `large-variant-space` warning plus stats, but the initial version does not stop generation because of it.

## 9. Determinism and cancellation

- AST traversal order, decision domains, environments, and attribute order are all explicitly sorted/stabilized.
- We never use the natural enumeration order of object keys, or TypeScript's internal IDs, as a persistent identity.
- We place a yield point — returning control to the event loop and calling `signal.throwIfAborted()` — at each phase boundary, and before evaluating each environment.
- An abort is returned to the caller as an `AbortError`, not converted into a `CoreDiagnostic`.
- We never return a partial `GenerateResult`.

## 10. Tests

At minimum, the following must be covered by fixture/golden tests:

1. A `v-if` and a ternary attribute that reference the same symbol/access path are evaluated under the same environment.
2. Identical spelling but different symbols, and identifiers scoped to a `v-for`, become separate decisions.
3. `v-if` / `v-else-if` / `v-else` are mutually exclusive.
4. Domain/fallback behavior for a literal union, nullish values, a general string, and an unevaluable expression.
5. `v-for` generates 0, 1, and a duplicated 2-item exemplar, correlated with a `length` predicate over the same collection.
6. Transition/Teleport/TransitionGroup/Suspense, and a direct `v-slot`.
7. Exclusion and diagnostics for custom components, slots, `v-html`, and custom directives.
8. Many-to-one mapping for static/dynamic/composed attributes.
9. Sentinel provenance preserves the expression range and reason.
10. UTF-16 ranges stay correct across emoji, surrogate pairs, and newlines inside attribute values.
11. Casing and namespaces for HTML/SVG/MathML, void elements, and escaping.
12. Variant ID, order, HTML, and map are identical for the same input.
13. Exceeding the threshold produces a warning but still generates every candidate.
14. Aborting during generation never returns a partial result.
15. Reverse lookup of a zero-width range (inside an element, at a boundary, at EOF) resolves according to the rules in §7.2.
16. Unknown fallback for unsupported expressions (IF generates both branches locally; `v-bind` falls back to a finite union or a dummy), and promotion of a side-effect-free predicate to a predicate decision, correlated with its simple negation.
17. Newline normalization in a text node (LF / CRLF → space), newline loss in `<pre>` / `<textarea>`, and the source-to-generated transformation and mapping correspondence, including character-reference conversion.
18. Custom-directive attribute value modeling (§5.3.1, ADR-0010): a single resolvable attribute; multi-attribute fan-out from one bound object expression, including a constant attribute keeping `source-literal` provenance alongside `$value`-path siblings; an unresolvable bound expression (a function call) falling back to a placeholder plus an info diagnostic; the boolean-attribute/null/undefined drop rule reused unchanged; a decision-bound identifier inside the bound expression producing correctly correlated variants (and an all-constant mapping registering no decision even when its bound expression references one); an undeclared directive name's dispatch staying unchanged when unrelated mappings are configured; a literal-string constant never evaluated as an expression; camelized name matching in both spellings; core-side defensive validation of a reserved directive name, an invalid attribute key, a malformed `$value`-containing value template, and camelized-duplicate entries (all dropped, with a warning); and own-properties-only `$value` lookup rejecting `constructor`/`toString`/`__proto__`.

For mapping, each entry is asserted both ways: `html.slice(generated.start, generated.end)` against the expected fragment, and `source.slice(source.start, source.end)` against the expected syntax.

## 11. Known limitations

- This is a correlated approximation over a finite Decision Model, not an exhaustive enumeration of all JavaScript runtime state.
- Semantic aliases and relationships internal to a function are not tracked.
- The 2-item case of `v-for` is a duplicate of the same exemplar; it does not model per-row value differences, or problems that only occur with three or more items.
- The content of custom components/slots, and the content model across a component boundary, are not verified.
- The results of custom directives, `v-html`, and runtime DOM mutation are not verified. A declared `customDirectives` mapping (§5.3.1) is an unverified assertion, not verified execution — it can produce a false negative if wrong or stale, and it never models `$arg`/`$modifiers`, or a bound expression containing a function call.
- Because of one-line serialization, newlines inside text content — for example, inside `<pre>` — are lost. Newlines inside attribute values are preserved as `&#10;`.
- Dummy/sentinel values may intentionally trigger a validator's strict rules. The analyzer uses provenance to normalize these into a bridge-specific explanation.

## 12. Proposed internal module layout

```text
src/
├── index.ts                  # public exports
├── generate.ts               # pipeline entry point
├── sfc/                      # SFC parsing, template offsets
├── typescript/               # symbol/type/access-path resolution
├── decisions/
│   ├── collector.ts
│   ├── model.ts
│   ├── expression-plan.ts
│   └── enumerate.ts
├── render/
│   ├── evaluator.ts
│   ├── vue-builtins.ts
│   ├── directives.ts
│   ├── form-values.ts
│   └── fragments.ts
├── serialize/
│   ├── serializer.ts
│   ├── escaping.ts
│   └── mapping.ts
└── diagnostics.ts
```

`decisions` handles Vue AST traversal and value evaluation, `render` builds fragments under an environment, and `serialize` produces the strings and the mapping. The serializer never calls the TypeScript type resolver.
