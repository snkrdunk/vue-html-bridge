# `vue-html-bridge` (core) Design

Status: Proposed  
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

The public API is async. The core's own processing (compiler, TypeScript) is CPU-bound synchronous work, but running it as a synchronous API inside the single-threaded LSP process would block the event loop — during that time, the process could not receive `didChange` notifications or observe an `AbortSignal` firing. To avoid this, we place yield points at phase and environment boundaries that return control to the event loop, and check the signal at each one. The delay before cancellation takes effect is bounded by the longest synchronous segment (for example, resolving the type of a single expression). If measurements show this is not good enough, the internal implementation can move to a worker thread without changing the public API (language-server.md §14).

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

`TypeAnalysisContext` abstracts ownership of the TypeScript program/project service. Whether core owns the concrete lifecycle of the project service, or the caller injects it, will be decided during the Phase 0 spike. The public API is designed to work either way.

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
}
```

`customElements` is not a function (unlike Vue's `isCustomElement`) because a function cannot be normalized into a cache key, and cannot be passed through JSON-based LSP settings either. The public contract is that `GenerateOptions` as a whole consists only of JSON-compatible values, so that the normalized result can be used directly as the cache key for the core result cache.

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
- `v-bind` / `v-model`: if the whole expression's type can be resolved to a finite union, generate only those candidates locally. If that is not possible either, fall back to a type-appropriate dummy value plus an `expression-not-symbolically-evaluable` diagnostic.
- Multiple occurrences of the same unevaluable expression are, in principle, not correlated with each other, since a function call (for example) is not guaranteed to return the same result each time. Only side-effect-free boolean expressions can be promoted to a predicate decision.

Unevaluable-expression diagnostics are not added redundantly per environment by the renderer. When the Decision Model is built, we record one entry per expression, keyed by "diagnostic code + source range of the template expression". Only the rendered result of the local fallback varies per environment.

The complete table mapping expression grammar to evaluators will be fixed as a Phase 0 spike fixture, and this section will be updated accordingly. Unsupported expressions receive no treatment beyond the fallback rules above.

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
- `<slot>` and its fallback children are not emitted.
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
| Custom directive                        | Directive is removed, with a diagnostic noting that DOM/attribute side effects are not modeled                            |
| `v-pre`                                 | The subtree the Vue compiler treats as literal is emitted statically                                                      |

Event modifiers are reduced to the base event; modifiers such as `.capture` / `.once` / `.passive` do not affect the HTML attribute name. Cases that need Vue runtime semantics, such as the event-name conversion for `.right` / `.middle`, are pinned down with fixtures.

Handling of `v-bind` modifiers: `.prop` and the `.` shorthand bind to a DOM property and do not emit an HTML attribute. `.camel` camelizes the attribute name. `.attr` emits a normal attribute. The Vue 3.4 same-name shorthand (`:value`) is treated as a normal `v-bind`.

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

For mapping, each entry is asserted both ways: `html.slice(generated.start, generated.end)` against the expected fragment, and `source.slice(source.start, source.end)` against the expected syntax.

## 11. Known limitations

- This is a correlated approximation over a finite Decision Model, not an exhaustive enumeration of all JavaScript runtime state.
- Semantic aliases and relationships internal to a function are not tracked.
- The 2-item case of `v-for` is a duplicate of the same exemplar; it does not model per-row value differences, or problems that only occur with three or more items.
- The content of custom components/slots, and the content model across a component boundary, are not verified.
- The results of custom directives, `v-html`, and runtime DOM mutation are not verified.
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
