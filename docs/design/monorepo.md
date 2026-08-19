# vue-html-bridge Monorepo Overall Design

Status: Proposed  
Revision: 1  
Last updated: 2026-08-18

## 1. Purpose

We derive the multiple static HTML outputs that a Vue 3 Single-File Component (SFC) `<template>` can produce, validate them with standard HTML validators, and map the results back to positions in the original SFC. We then deliver those results to an LSP client.

The first supported validator is Markuplint. However, we separate SFC interpretation, validator execution, reverse-mapping of diagnostics, and LSP communication, so we can add other validators later, such as the [Nu HTML Checker](https://github.com/validator/validator).

The experience the user gets in the end is as follows:

- When the user edits a `.vue` file in an LSP-enabled editor, the file is analyzed automatically.
- The tool evaluates `v-if`, `v-for`, dynamic attributes, and so on, and validates each possible resulting HTML output.
- Errors and warnings appear at the correct line and column in the original SFC, and the user can jump to them from the Problems UI or similar.
- Hovering over a diagnostic position shows the message, the rule, the validator, and information about the relevant variant.
- Adding a new validator-specific implementation does not require changes to core or the language server.

## 2. Scope

### 2.1 Included in the initial release

- Parsing the `<template>` of a Vue 3 SFC
- Building a finite Decision Model from the types and expressions in the script/template
- Generating a static HTML variant for each combination in the Decision Model
- Bidirectional provenance information between the generated HTML and the SFC
- Validation with Markuplint
- A validator-agnostic diagnostic format, reverse mapping, and cross-variant aggregation
- LSP push diagnostics, hover, cancellation, and document version management
- A public interface and contract tests for future adapters

### 2.2 Not included in the initial release

- Validating the DOM produced by actually running and mounting a Vue component
- Inlining a child component's template into its parent
- Validating the HTML content model across component boundaries
- Parsing arbitrary HTML injected via `v-html`
- General symbolic execution of JavaScript
- Automatic fixes or code actions for diagnostics
- A CLI for bulk-analyzing an entire repository (this can be added later as a consumer of `analyzer`)
- Editor-specific extensions. The LSP client relies on each editor's existing features or a thin launch configuration.

## 3. Design principles

1. **core does not know about HTML validators.** It is responsible only for converting an SFC into static HTML variants and a source map.
2. **An adapter does not know about Vue SFCs.** It validates one HTML string and returns diagnostics against the generated HTML.
3. **analyzer does not know about LSP.** It validates variants, performs reverse mapping and aggregation, and returns results as absolute offsets into the SFC.
4. **Only the language server knows LSP types and lifecycle.** Conversion to line/column, document version, publish, and hover happens at this boundary.
5. **Internal coordinates always use UTF-16 absolute offsets.** Line/column or validator-specific coordinates are converted only at each boundary.
6. **The same input always produces the same order, IDs, and diagnostics.** We require determinism, for caching, testing, and to prevent diagnostics from flickering.
7. **Failures are isolated.** A configuration or execution error in one adapter must not cause core diagnostics or other adapters' results to be lost.
8. **We never implicitly load arbitrary code.** An external adapter requires explicit workspace configuration and trust.

## 4. Package structure

| Package                               | Main responsibility                                                    | Explicitly out of scope                                |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `vue-html-bridge`                     | SFC parsing, Decision Model, variants, mapping, provenance             | Running validators, diagnostic aggregation, LSP        |
| `@vue-html-bridge/validator-api`      | The stable SPI adapters implement, and normalized diagnostic types     | SFC parsing, running a specific validator              |
| `@vue-html-bridge/analyzer`           | Running core and adapters, reverse mapping, aggregation, caching       | LSP communication, validator-specific APIs             |
| `@vue-html-bridge/adapter-markuplint` | Resolving Markuplint configuration, running it, converting coordinates | SFC mapping, LSP, cross-variant aggregation            |
| `@vue-html-bridge/language-server`    | LSP lifecycle, settings, publishDiagnostics, hover                     | SFC conversion logic, direct use of the Markuplint API |
| `@vue-html-bridge/adapter-testkit`    | Adapter contract tests, fake adapter, fixture utilities                | Production runtime                                     |

The goal for a future `@vue-html-bridge/adapter-vnu` is that it implements only `validator-api`, and can be added without changing `analyzer` or `language-server`.

### 4.1 Dependencies

An arrow means "the left side depends on the right side."

```text
@vue-html-bridge/language-server
  ├──> @vue-html-bridge/analyzer ──> vue-html-bridge
  │                               └─> @vue-html-bridge/validator-api
  ├──> @vue-html-bridge/adapter-markuplint ──> @vue-html-bridge/validator-api
  └──> @vue-html-bridge/validator-api   # runtime validation of external adapters

@vue-html-bridge/adapter-testkit ──> @vue-html-bridge/validator-api

future: @vue-html-bridge/adapter-vnu ──> @vue-html-bridge/validator-api
```

Circular dependencies are forbidden. In particular, core must never depend on analyzer, an adapter, or the LSP.

### 4.2 Planned repository structure

```text
vue-html-bridge/
├── docs/design/
├── packages/
│   ├── core/                 # package name: vue-html-bridge
│   ├── validator-api/
│   ├── analyzer/
│   ├── adapter-markuplint/
│   ├── language-server/
│   └── adapter-testkit/
├── examples/
│   └── playground/
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

We plan to use a pnpm workspace for package management. Changesets is a candidate for tracking changelogs and independent versioning of published packages, but we will decide the build tooling in an ADR when implementation starts.

## 5. End-to-end data flow

```text
LSP client
    │ didOpen / didChange
    v
language-server
    │ AnalyzeRequest (source snapshot, version, config, AbortSignal)
    v
analyzer
    │ GenerateRequest
    v
core ──> Variant[] + SourceMap + CoreDiagnostic[] + GenerationStats
    │
    └── analyzer ── each Variant × enabled Adapter ──> GeneratedDiagnostic[]
                         │
                         v
                 reverse mapping + provenance rewrite
                         │
                         v
             occurrence identity / source identity aggregation
                         │
                         v
                  SourceDiagnostic[]
                         │
                         v
language-server ── offset → LSP Position ──> publishDiagnostics / hover
```

1. The language server passes a snapshot of the source being edited and the document version to analyzer.
2. analyzer calls core exactly once, so all adapters share the same variants.
3. Each adapter validates each variant independently, as a static HTML document.
4. analyzer uses the generated range and the mapping to find one or more origins in the SFC.
5. If the provenance shows a bridge-specific artifact such as a sentinel, analyzer replaces the validator's surface-level message with a bridge-specific diagnostic.
6. After identifying occurrences within a variant, analyzer aggregates diagnostics across variants that point to the same underlying cause in the SFC.
7. The language server converts only the results for the latest document version into LSP ranges, and publishes them.

## 6. Common data contracts

### 6.1 Coordinate system

Every internal range satisfies the following:

```ts
interface OffsetRange {
  /** UTF-16 code unit offset. Inclusive. */
  start: number;
  /** UTF-16 code unit offset. Exclusive. */
  end: number;
}
```

- Offsets are UTF-16 code units, the same unit JavaScript string indexing uses.
- Ranges are half-open: `[start, end)`.
- We require `0 <= start <= end <= text.length`.
- core handles absolute offsets in both the source and the generated HTML.
- An adapter converts validator-specific byte offsets, code points, or line/column values into generated UTF-16 offsets.
- The language server converts source UTF-16 offsets into the line/character format the client's chosen LSP position encoding uses.

We fix the coordinate unit through type names, JSDoc, and contract tests, and we do not let an implicit "column" leak into cross-package APIs. Because `SourceRange` and `GeneratedRange` are structurally assignable to each other, we recommend using branded types or constructor/assertion helpers in the implementation, to prevent mixing them up.

### 6.2 Variant identity

```ts
interface VariantDescriptor {
  id: string;
  ordinal: number;
  decisions: readonly DecisionAssignment[];
}
```

- `ordinal` is a deterministic enumeration order, used for display and debugging.
- `id` is generated deterministically from the core version, the generation options that affect output, and the normalized decision assignments.
- We never use `ordinal` alone as a persistent diagnostic ID.
- Even when two variants generate identical HTML, we do not discard the evidence from different decisions. However, an adapter's execution result may be reused based on the HTML content hash.

### 6.3 Diagnostic stages

We separate diagnostics into three stages.

```ts
// validator-api: on the generated HTML
interface GeneratedDiagnostic {
  ruleId?: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  range?: OffsetRange;
  fingerprint?: string;
  applicability?:
    | "html-semantics"
    | "source-representation"
    | "document-context";
}

// analyzer internal: a concrete occurrence in a specific variant
interface DiagnosticOccurrence {
  adapterId: string;
  variantId: string;
  generated: GeneratedDiagnostic;
  origins: readonly SourceOrigin[];
}

// analyzer output: the problem shown to the user, in the SFC
interface SourceDiagnostic {
  sourceRange: OffsetRange;
  relatedInformation: readonly SourceRelatedInformation[];
  origin: "core" | "validator" | "adapter";
  adapterId?: string;
  code: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  evidence: DiagnosticEvidence;
}
```

Each package's own document is the authority on the exact type definitions. It is important not to mix these three stages. If we include the generated range in the cross-variant aggregation key, the same problem in the same SFC location shows up once per variant. On the other hand, if we group only by source range from the start, we risk incorrectly merging two different problems that happen to occur within the same variant. So we first establish the occurrence identity, and only after that do we aggregate by source identity.

### 6.4 Source map and many-to-one mapping

A single generated range can have multiple source origins, for example because of a synthesized attribute or a sentinel. analyzer treats the most specific origin as primary, and the rest as related information. When a validator diagnostic has no locatable position, we fall back to the SFC's `<template>` start tag, or the template content range.

### 6.5 The validation context is an HTML fragment

A single SFC template usually generates an HTML fragment, not a full HTML document. core does not add an implicit `html`, `head`, or `body`, and does not fill in where a parent component or slot content will be inserted.

Because of this, we distinguish two kinds of validator rules:

- **Fragment-local rules:** rules that can be judged from the current output alone, such as attribute values, the element itself, or a parent-child relationship that closes within the fragment.
- **Host/document-context-dependent rules:** rules that cannot be judged without knowing where the fragment will be placed, such as whether `html`/`head`/`meta` are required, ID references outside the fragment, or the content model after a parent component or slot inserts content.

Results from the latter are not standard validation results for a complete browser document. Each adapter must document how it treats fragments, and which document-only rules are disabled in its default profile. The responsibility for not applying document-root rules that clearly do not fit a component fragment by default belongs to each adapter's profile (for example, adapter-markuplint's `generated-html` profile). We still leave room for the user to enable such rules intentionally; in that case analyzer does not suppress those diagnostics (see analyzer.md §7).

## 7. Adapter SPI

An adapter implements `HtmlValidatorAdapter` from `@vue-html-bridge/validator-api`.

```ts
interface HtmlValidatorAdapter<TSettings = unknown> {
  readonly apiVersion: 1;
  readonly id: string;
  readonly displayName: string;
  createSession(
    context: AdapterSessionContext<TSettings>,
  ): Promise<ValidatorSession>;
}

interface ValidatorSession {
  validate(
    request: ValidateHtmlRequest,
    signal: AbortSignal,
  ): Promise<ValidateHtmlResult>;
  dispose(): Promise<void>;
}
```

We separate out a session so that configuration loading, external processes, the validator engine, and file watchers can be reused and disposed of per workspace. For example, a future Nu HTML Checker adapter could hold a Java process or an HTTP service as the internal implementation of its session.

An adapter must guarantee the following:

- It validates a single `ValidateHtmlRequest` as a static HTML fragment, not as Vue. If the validator requires a full document, the adapter must handle adding a wrapper, excluding wrapper-only diagnostics, and correcting ranges, entirely within the adapter.
- It normalizes the validator's diagnostics to generated UTF-16 ranges and a common severity.
- It uses `sourceFilename` for configuration lookup, and `virtualFilename` for the HTML parser or any virtual input name, keeping the two separate.
- It respects `AbortSignal`. Any validator startup or configuration failure other than cancellation must be returned as a structured failure.
- It does not depend on the SFC source map, variant aggregation, or LSP types.
- It does not modify the source or the generated HTML.

## 8. LSP design policy

Our LSP implementation is based on [Language Server Protocol 3.18](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/).

The initial implementation uses push diagnostics, for broad compatibility.

- `initialize`: declares incremental text sync, a hover provider, and workspace folders.
- `didOpen` / `didChange`: analyzes after a debounce period. Cancels any previous analysis.
- `didSave`: re-analyzes immediately, if configured to do so.
- `didClose`: publishes empty diagnostics and discards the cache.
- `workspace/didChangeConfiguration`: rebuilds sessions and re-analyzes open documents.
- `textDocument/hover`: returns details of any diagnostic overlapping that position, from the latest cached source diagnostics.
- `publishDiagnostics`: always includes the document version at the start of analysis, and never publishes a stale result.

We do not add a custom request for "jump to this position." Publishing the standard `Diagnostic.range` and URI is enough for the LSP client's Problems UI or diagnostic navigation to work. We convert multiple origins into `Diagnostic.relatedInformation`.

Pull diagnostics, workspace diagnostics, and code actions are out of scope for the initial release. We will add them later, after checking client compatibility and measuring processing time.

## 9. Settings and adapter discovery

The priority order of configuration sources is as follows:

1. Editor/workspace settings obtained via LSP `workspace/configuration`
2. The workspace's `.vue-html-bridge.json`, or the `vueHtmlBridge` field in `package.json`
3. Package defaults

We do not merge arrays; a higher-priority value fully replaces a lower-priority one. We publish the configuration schema and its version.

```json
{
  "$schema": "./node_modules/@vue-html-bridge/language-server/schema.json",
  "validators": [
    {
      "adapter": "@vue-html-bridge/adapter-markuplint",
      "enabled": true,
      "settings": {
        "configFile": ".markuplintrc"
      }
    }
  ],
  "debounceMs": 200,
  "maxConcurrency": 4,
  "warnVariantCount": 256
}
```

The authoritative structure is the flat `VueHtmlBridgeSettings` in language-server.md §9.2; the language server is responsible for decomposing it into each package's options.

The numeric values in the JSON example above are illustrative. The authoritative defaults live in each package's own document (core.md §2.1, language-server.md §9.2); we do not define them here.

The initial release bundles the Markuplint adapter and enables it by default. External adapters are loaded under these rules:

- The package name must be given explicitly in the settings. We do not auto-discover adapters.
- We use the workspace's module resolution; the language server never searches arbitrary paths of its own.
- On a client where workspace trust is not granted, we do not load external adapters.
- An `apiVersion` mismatch is surfaced explicitly, either as a workspace-level diagnostic or via `window/showMessage`.
- We document that loading an adapter package means executing code.

## 10. Performance, cancellation, and caching

### 10.1 Number of variants

The number of variants can grow exponentially with the number of independent decisions. Even so, we do not require a configurable hard limit from the first release. Instead, we implement the following first, and collect measurements from real projects:

- core returns `candidateCount`, `emittedCount`, `uniqueHtmlCount`, and generation time.
- We warn when a default threshold is exceeded.
- We make it possible to identify heavy SFCs from the LSP log or hover evidence.
- Cancellation and stale-result suppression are mandatory.

If real data shows that this hurts the editing experience, we will consider a hard limit, sampling, or constraint solving in a separate ADR.

### 10.2 Cache layers

| Layer                 | Rough key                                                                               | Invalidation                                    |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| core parse/generation | source hash, compiler/core version, generate options, project epoch                     | Source, type environment, or option changes     |
| adapter validation    | adapter/version, settings hash, sourceFilename, HTML content hash (scoped to a session) | Session recreation (config change), HTML change |
| analyzer diagnostics  | The keys above, plus mapping version                                                    | core/adapter result change                      |
| LSP position index    | document URI, version                                                                   | didChange/didClose                              |

If different decisions happen to generate the same HTML, adapter validation can share results by content hash. However, we still keep every variant ID in the evidence.

### 10.3 Concurrency

Adapter validation runs with bounded concurrency. Because some adapters wrap external processes, unlimited fan-out via `Promise.all` is forbidden. The default value takes CPU count and adapter capability into account, and can be overridden by configuration.

## 11. Error handling

| Failure                                 | Handling                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| SFC parse/type analysis failure         | Reported as a core diagnostic. We continue generating whatever is still possible.    |
| Partial variant generation failure      | Recorded as a core diagnostic and in stats; we continue with the other variants.     |
| Adapter configuration failure           | Converted into a source diagnostic from that adapter; only that adapter is stopped.  |
| Validator crash on a single variant     | That occurrence becomes a failure; we continue with the other variants and adapters. |
| Cancellation                            | Not turned into a diagnostic; the result is discarded.                               |
| Completion for a stale document version | Not published; the result is discarded.                                              |
| Mapping does not resolve                | We fall back to the template range, and keep mapping-failure metadata.               |

We distinguish validator errors that return no range, configuration errors, and process crashes from ordinary HTML violations. In the LSP display, `source`, `code`, and the message prefix make this distinction visible.

## 12. Test strategy

### 12.1 Per package

- core: fixtures and property tests for the parser, Decision Model, variants, mapping, and provenance
- validator-api: TypeScript API compatibility, JSON serializability
- analyzer: reverse mapping using a fake adapter, two-stage aggregation, failure isolation, cache/cancel
- Markuplint adapter: golden tests against the real engine, and configuration resolution
- language server: JSON-RPC in-memory/stdio integration tests, version races, hover, multi-root
- adapter-testkit: self-tests, plus confirming that the Markuplint adapter passes the contract suite

### 12.2 Across the monorepo

We require a vertical-slice E2E test that runs a single `.vue` fixture all the way from an LSP request to Markuplint diagnostics being published. At minimum, this must include the items below. Each item is annotated with the implementation Phase (§14) in which it becomes true. The vertical-slice E2E itself exists starting from Phase 1.

- Generates variants where a dynamic attribute referencing the same expression as `v-if` never contradicts it. (Phase 2)
- `v-for` generates variants for 0, 1, and 2 items, correlated with the matching length conditions on the same collection where possible. (Phase 2)
- UTF-16 ranges match correctly for an SFC containing an emoji and a line break inside an attribute value. (Phase 1)
- The same source-level problem occurring in multiple variants is reported as a single diagnostic. (Phase 2)
- Multiple origins from a synthesized attribute become related information. (Phase 2)
- A stale result is not published when a `didChange` arrives mid-analysis. (Phase 2)
- Core diagnostics are still published even when Markuplint fails. (Phase 1)

## 13. Release and compatibility

- Each package has its own independent semantic version.
- Compatibility of the `validator-api` SPI is judged by both `apiVersion` and semver.
- Changes to core's mapping/provenance types must record their impact on analyzer in the same changeset. Changes to common coordinate contracts, such as UTF-16 or half-open ranges, require a joint major compatibility review across validator-api and all adapters.
- The language server's user settings schema avoids breaking changes, and gives a deprecation period before removing anything.
- The internal representation of generated HTML is not a public protocol. We pass only HTML and metadata to adapters, and do not expose core's internal AST.

## 14. Implementation phases

Phase 1 and Phase 2 are internal milestones, not published to npm. The "initial release" in §2.1 refers to the release at the completion of Phase 3. Any temporary limitations from Phase 1 (such as the lack of cross-expression correlation) do not appear in the public external specification.

### Phase 0: Types and technical spikes

- Confirm that we can build a Decision Model from the compiler AST and TypeScript type analysis.
- Confirm that Markuplint's Node API can reliably take string HTML and an explicit config, and return generated ranges.
- Build round-trip fixtures for the LSP client and UTF-16 offsets.
- Measure core's longest synchronous segment on representative fixtures (a large SFC, a large type environment), and define a response-time budget (target: 100 ms for a single synchronous segment). If the budget is exceeded, decide in an ADR, before the initial release, whether to move core execution to a worker thread, and design how to pass `TypeAnalysisContext` across the worker boundary.
- Finalize the first version of the rule manifest for Markuplint's generated-html profile (adapter-markuplint §5).

### Phase 1: Vertical slice

- The minimal variant generation and mapping in core. Scope: expanding a single expression's `boolean` / literal union (no cross-expression correlation; each node's decision is independent), `v-for` produces one exemplar, and provenance is limited to `source-literal` / `sentinel`. Decision Model correlation (core.md §4.1) is introduced in Phase 2; in Phase 1 we temporarily accept the over-approximation caused by independent expansion (including variants that are internally contradictory).
- validator-api v1
- Markuplint adapter
- analyzer running a single adapter, with reverse mapping
- The language server's open/change/publishDiagnostics

### Phase 2: Editing experience and robustness

- Global Decision Model, `v-for` 0/1/2, sentinel provenance
- Two-stage aggregation, hover, related information
- Debounce, cancellation, version gating, cache
- Configuration changes and multi-root workspaces

### Phase 3: Finalizing the adapter SDK

- Publishing adapter-testkit
- External adapter loading and trust policy
- validator-api compatibility documentation, sample adapter

### Phase 4: Validating the design with a second adapter

- Prototype a process- or service-based Nu HTML Checker adapter.
- Confirm that no Markuplint-specific assumptions have leaked into validator-api/analyzer.

## 15. Open questions

The following will be decided by ADR, after an implementation spike or measurement. Each item notes where the decision will be made.

- Whether the Vue/TypeScript project service is shared inside the core process, or injected by analyzer (Phase 0 spike)
- Whether `sourceFilename` or `virtualFilename` should apply to Markuplint's config override (Phase 0 spike; adapter-markuplint §4.2)
- The scope of support if a client chooses UTF-8/UTF-32 position encoding (Phase 0 client matrix)
- The default threshold for the variant warning, and a way to measure it without telemetry (after Phase 2 measurement)
- Whether sandboxing external adapters is feasible. At minimum, the initial release relies on trust and explicit configuration. (Phase 3)
- The conditions for moving from push diagnostics to pull diagnostics (after Phase 2 measurement)

## 16. References

- [Vue Language Tools](https://github.com/vuejs/language-tools)
- [Language Server Protocol 3.18](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)
- [Markuplint](https://markuplint.dev/)
- [Nu HTML Checker](https://github.com/validator/validator)
