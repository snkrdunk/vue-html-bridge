# `@vue-html-bridge/analyzer` Design

Status: Proposed
Package directory: `packages/analyzer`

## 1. Role

This is the application service that combines core with one or more validator adapters to complete the analysis of a single SFC.

### In scope

- Run core once to get variants
- Run enabled adapters with bounded concurrency
- Map generated diagnostics back to the SFC
- Normalize diagnostics into bridge-specific ones, based on mapping provenance
- Identify occurrences inside a variant, and aggregate them across variants
- Merge core/adapter/validator diagnostics into a single result
- Handle workspace session, cache, cancellation, and failure isolation

### Out of scope

- Implementing the Vue AST/HTML serialization
- Validator-specific APIs such as Markuplint's
- Dynamically loading adapters from npm packages
- LSP `Position`, `Diagnostic`, JSON-RPC
- Editor document lifecycle

## 2. Public API

The language server (and a future CLI) creates one `WorkspaceAnalyzer` per workspace.

```ts
export interface CreateWorkspaceAnalyzerOptions {
  workspaceRoot: string;
  adapters: readonly ConfiguredAdapter[];
  generateOptions?: GenerateOptions;
  /**
   * Constructed and owned by the caller, one per workspace (ADR-0002; core.md
   * §2). The analyzer forwards it unchanged on every internal
   * `generateVariants` call and reads its current `epoch` when computing the
   * core-result cache key (§10.2). The caller retains its own reference and
   * calls `typeContext.invalidate(filenames)` directly when it observes a
   * relevant file change — invalidation is a mutation on an object the
   * caller already owns, not a separate analyzer API. Omitting this option
   * is valid (core defaults to reading real files with no unsaved-buffer
   * overlay and an epoch that never advances).
   */
  typeContext?: TypeAnalysisContext;
  maxConcurrency?: number;
  logger?: AnalyzerLogger;
}

export interface ConfiguredAdapter<TSettings = unknown> {
  adapter: HtmlValidatorAdapter<TSettings>;
  settings: TSettings;
  enabled: boolean;
}

export interface WorkspaceAnalyzer {
  analyze(request: AnalyzeRequest): Promise<AnalysisResult>;
  reconfigure(options: ReconfigureOptions): Promise<void>;
  getConfigWatchTargets(): readonly AnalyzerConfigWatchTarget[];
  dispose(): Promise<void>;
}

export interface ReconfigureOptions {
  adapters?: readonly ConfiguredAdapter[];
  generateOptions?: GenerateOptions;
  maxConcurrency?: number;
  /**
   * Forces recreation of the specified adapter's session even when the
   * settings hash is unchanged. This is how the language server applies
   * config-file changes it is watching (§11).
   */
  invalidateAdapters?: readonly string[];
}

export interface AnalyzerConfigWatchTarget extends ConfigWatchTarget {
  adapterId: string;
}

export async function createWorkspaceAnalyzer(
  options: CreateWorkspaceAnalyzerOptions,
): Promise<WorkspaceAnalyzer>;
```

Resolving the adapter package and deciding whether to trust it is the caller's responsibility. The analyzer only accepts adapter instances that are already loaded and have passed runtime validation.

`getConfigWatchTargets()` returns a deterministic, deduplicated snapshot from all live adapter sessions, tagged with `adapterId`. The language server queries it after session creation/reconfiguration and after analysis, because `validate()` may discover a nearer config or another resolved dependency. The analyzer validates adapter-returned target shapes at this boundary and ignores an invalid snapshot after reporting an adapter programming failure.

### 2.1 Analyze request/result

```ts
export interface AnalyzeRequest {
  uri: string;
  filename: string;
  source: string;
  documentVersion?: number;
  signal: AbortSignal;
}

export interface AnalysisResult {
  uri: string;
  documentVersion?: number;
  diagnostics: readonly SourceDiagnostic[];
  variantSummary: VariantSummary;
  timing: AnalysisTiming;
}

export interface VariantSummary {
  candidateCount: number;
  emittedCount: number;
  uniqueHtmlCount: number;
  warningThresholdExceeded: boolean;
}
```

The analyzer receives the source snapshot as a value on the request. It does not re-read the `.vue` file from the filesystem. This keeps diagnostics in sync with the version of unsaved editor buffers.

## 3. Source diagnostic

```ts
export interface SourceDiagnostic {
  id: string;
  origin: "core" | "validator" | "adapter";
  sourceRange: SourceRange;
  relatedInformation: readonly SourceRelatedInformation[];
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code: string;
  adapterId?: string;
  codeDescriptionHref?: string;
  evidence: DiagnosticEvidence;
}

export interface SourceRelatedInformation {
  sourceRange: SourceRange;
  message: string;
}

export interface DiagnosticEvidence {
  variantCount: number;
  variantIds: readonly string[];
  exampleDecisions: readonly DecisionAssignment[];
  generatedExample?: {
    virtualFilename: string;
    range?: GeneratedRange;
  };
  truncated: boolean;
  originalValidatorMessage?: string;
}
```

- `id` is derived deterministically from the diagnostic content and the source identity. It does not include the document version.
- The evidence keeps at most 5 variant IDs and decisions by default. Beyond that, `variantCount` and `truncated` indicate the rest.
- `relatedInformation` holds at most 8 entries, ordered by the priority in §6.1. Any excess is indicated by a count in the message.
- The full generated HTML is never included in the result. Even debug APIs and logs require explicit opt-in to include it.
- Adapter failures are also converted to source diagnostics, but with `origin: "adapter"` so they are distinguished from HTML violations.

## 4. Analysis pipeline

```ts
async function analyze(request: AnalyzeRequest): Promise<AnalysisResult> {
  const generated = await getOrGenerateVariants(request);
  request.signal.throwIfAborted();

  const work = uniqueHtmlPerAdapter(generated.variants, enabledSessions);
  const validatorResults = await runBounded(
    work,
    maxConcurrency,
    request.signal,
  );

  const occurrences = attachResultsToAllVariants(validatorResults);
  const remapped = occurrences.flatMap(remapOccurrence);
  const normalized = remapped.map(rewriteUsingProvenance);
  const aggregated = aggregateBySourceIdentity(normalized);

  return mergeCoreAndAdapterDiagnostics(generated, aggregated);
}
```

The implementation defines an intermediate type for each stage, and does not mix generated diagnostics and source diagnostics into the same array early.

## 5. Running adapters

### 5.1 Work item

Logically, a work item is `adapter × variant`, but if the HTML passed to the same adapter/settings pair is identical, it only runs once.

```ts
interface ValidationWorkItem {
  adapterId: string;
  htmlHash: string;
  html: string;
  representativeVariantId: string;
  memberVariantIds: readonly string[];
}
```

The result is reattached to every `memberVariantIds` entry, so evidence is preserved. Results are not shared across different adapters, even when the HTML is identical.

### 5.2 Virtual filename

```ts
function virtualFilename(sourceFilename: string, htmlHash: string): string {
  return `${sourceFilename}.__vue_html_bridge__/variant-${htmlHash}.html`;
}
```

The format follows the normative definition in validator-api §3.2. Because the final segment is derived from the HTML content hash, work items with identical HTML share the same virtual filename. This means path-dependent config (such as `overrides` or `excludeFiles`) is not affected by which variant is chosen as the representative for validation. The path does not need to exist on the filesystem. If an adapter needs a real file, the adapter itself is responsible for managing a safe temporary location and its cleanup.

### 5.3 Concurrency

- `maxConcurrency` applies to the whole queue.
- The adapter capability `maxConcurrentValidations` is also enforced as a per-session limit. The effective concurrency is the minimum of the two.
- No new work starts after the signal is aborted.
- Results that complete for an adapter without cancellation support are discarded.
- A rejection from one work item is caught and does not cancel other work items.

## 6. Reverse mapping

### 6.1 With a range

`GeneratedDiagnostic.range` is passed to core's `findSourceOrigins`. The resulting origins are ordered by this priority:

1. Largest overlap with the diagnostic range
2. Order of specificity: `attribute-value`, `attribute-name`, `element-name`, `text`
3. Shorter source range
4. Source start position

The first entry becomes `sourceRange`, and the rest become `relatedInformation`. However, if the mapping shows that the same generated diagnostic was deliberately duplicated into multiple, independent locations, a single primary is not chosen — the source diagnostic fans out instead. The internal type is left open so a transformation group ID can be added to a mapping entry later.

### 6.2 No range, or no mapping found

- If the validator diagnostic has no range, the start position of the `<template>` content is used.
- If a range exists but no mapping is found, the same fallback is used, and internal metadata equivalent to `mappingFallback: true` is kept in the evidence.
- If the `<template>` cannot be parsed, offset 0 of the SFC is used.
- Adapter configuration/execution failures are placed at the `<template>` start position. A future diagnostics API that lets the workspace file itself be the primary target is a separate matter to consider later.

A diagnostic that used a fallback is never shown as if it came from a specific HTML token. The message adds a note that the generated position could not be traced back to specific source syntax.

## 7. Normalization based on provenance

An adapter knows nothing about Vue or source maps, so interpreting diagnostics caused by representations the bridge created is the analyzer's job. The analyzer cross-references core's mapping provenance with the adapter/rule/range, and does one of the following:

- Source literal / finite domain: keep the validator diagnostic as is.
- Sentinel: replace it with a bridge-specific type-narrowing diagnostic.
- Synthetic transformation: suppress, or replace with a bridge-specific explanation, only for rules that have no meaning for that transformation.

Adapters normalize each rule into `html-semantics`, `source-representation`, or `document-context`. The analyzer does not know adapter-specific rule IDs, and decides only from this classification combined with the provenance kind/transformation — never from the message string. A diagnostic with no classification is kept as `html-semantics`, so diagnostics from unknown adapters are never suppressed by mistake.

Diagnostics classified as `document-context` are never suppressed. By default, the adapter's profile already disables the relevant rules (adapter-markuplint §5), so a diagnostic in this classification only arrives when the user has explicitly enabled it — in which case it is kept as is.

### 7.1 Sentinel

Core's policy of replacing a general `string` (etc.) with `dummy-string` is intentional: it nudges the user toward narrowing the type to a finite domain. But the validator's raw message alone could make the user think `dummy-string` actually exists in the source.

Example:

```vue
<script setup lang="ts">
defineProps<{ pressed: string }>();
</script>
<template>
  <button :aria-pressed="pressed">Toggle</button>
</template>
```

Generated HTML:

```html
<button aria-pressed="dummy-string">Toggle</button>
```

Raw validator diagnostic:

```ts
{
  ruleId: "invalid-attr",
  message: 'The value of "aria-pressed" must be "true", "false", or "mixed".',
  range: { start: 21, end: 33 }
}
```

Mapping:

```ts
{
  generated: { start: 21, end: 33 },
  source: { filename: "Toggle.vue", start: 116, end: 123 }, // pressed
  kind: "attribute-value",
  provenance: {
    kind: "sentinel",
    sourceRange: { filename: "Toggle.vue", start: 116, end: 123 },
    reason: "non-finite-type",
    originalType: "string"
  }
}
```

Normalized source diagnostic:

```ts
{
  origin: "validator",
  adapterId: "markuplint",
  code: "vue-html-bridge/non-finite-attribute-value",
  message:
    'Cannot narrow this attribute value to a finite set. Use a literal union allowed for aria-pressed (current type: string).',
  sourceRange: { filename: "Toggle.vue", start: 116, end: 123 },
  evidence: {
    originalValidatorMessage:
      'The value of "aria-pressed" must be "true", "false", or "mixed".'
  }
}
```

This rewrite does not happen unconditionally just because the validator range overlaps a sentinel mapping. It only applies when the diagnostic's primary range lies inside the sentinel value, and the source origin resolves uniquely to that expression. When this cannot be determined, the raw message is kept, and an explanation of the sentinel is added to the hover evidence.

If multiple validator diagnostics come from the same sentinel, they are combined into one bridge-specific diagnostic, and the original messages are kept as bounded related evidence.

The identity of the rewritten bridge diagnostic is defined as follows:

- `code` is a stable bridge code (e.g. `vue-html-bridge/non-finite-attribute-value`).
- The aggregation key has the same structure as the `sourceKey` in §8.2, but uses the bridge code instead of `ruleId`, and the provenance's `sourceRange` as the source range. `adapterId` stays part of the key, so if multiple adapters flag the same sentinel, each adapter produces one entry (they are not merged across adapters, since the `source` shown differs).
- The original diagnostics kept in the evidence are ordered deterministically by `ruleId` and message, and truncated at 5 by default.

### 7.2 Synthetic Vue transformation

For example, source code with `@click="save"` is converted to `onclick="dummy-fn"` so an A11y rule can recognize the click interaction. If Markuplint's "do not use inline event handlers" rule reacts to this `onclick`, that does not mean the source actually contains an inline HTML handler.

```ts
{
  generated: { start: 8, end: 26 },
  source: { filename: "Save.vue", start: 54, end: 67 },
  kind: "attribute-value",
  provenance: {
    kind: "synthetic",
    sourceRange: { filename: "Save.vue", start: 54, end: 67 },
    transformation: "vue-event"
  }
}
```

Suppression happens only when this range's provenance is `synthetic` and the diagnostic's `applicability` is `source-representation`. On the other hand, if the SFC has a real, static `onclick="save()"` and the provenance is `source-literal`, it is not suppressed. This avoids hardcoding Markuplint rule IDs in the analyzer, and produces fewer false negatives than disabling the whole rule through the adapter profile.

## 8. Two-stage diagnostic identity and aggregation

### 8.1 Stage 1: occurrence identity

This identifies a specific occurrence a validator reported inside one variant.

```ts
function occurrenceKey(x: DiagnosticOccurrence): string {
  return stableHash({
    adapterId: x.adapterId,
    variantId: x.variantId,
    ruleId: x.diagnostic.ruleId,
    fingerprint: x.diagnostic.fingerprint ?? normalize(x.diagnostic.message),
    generatedStart: x.diagnostic.range?.start,
    generatedEnd: x.diagnostic.range?.end,
  });
}
```

The generated range is included here so that, for example, two invalid `<button>` elements in the same variant are not merged into one issue by mistake.

### 8.2 Stage 2: source identity

After the reverse mapping, occurrences that represent the same root cause on the SFC are merged across variants.

```ts
function sourceKey(x: RemappedOccurrence): string {
  return stableHash({
    origin: x.origin,
    adapterId: x.adapterId,
    ruleId: x.code,
    fingerprint: x.fingerprint ?? normalize(x.message),
    filename: x.primary.filename,
    sourceStart: x.primary.start,
    sourceEnd: x.primary.end,
  });
}
```

`variantId` and the generated range are not included here. Even if the same source attribute appears at generated offset 20 in variant A and offset 80 in variant B, the user should see it as one issue.

Aggregation example:

```ts
const occurrences = [
  { variantId: "logged-in", generatedStart: 40, sourceStart: 120 },
  { variantId: "admin", generatedStart: 87, sourceStart: 120 },
];

const diagnostic = {
  sourceRange: { start: 120, end: 133 },
  message: "The id referenced by aria-controls does not exist",
  evidence: {
    variantCount: 2,
    variantIds: ["logged-in", "admin"],
    exampleDecisions: [
      /* the first representative environment */
    ],
  },
};
```

If severities differ, the strongest one is used. If only the message differs and it looks unstable, the adapter fingerprint is preferred; if there is no fingerprint, the diagnostics are kept separate. When merging is ambiguous, the analyzer chooses to show duplicates rather than merge incorrectly.

## 9. Merging core and adapter failures

### 9.1 Core diagnostic

A core diagnostic already has a source range, so it is not reverse-mapped. Its code is `vue-html-bridge/<core-code>`, and `origin` is `"core"`. Entries with the same `code + sourceRange` are merged into one.

### 9.2 Adapter failure

The code is:

```text
adapter/<adapter-id>/<failure-code>
```

placed at the template fallback range. The same adapter/session-level failure is not duplicated per variant.

- Configuration failure: one entry. The remaining work for that adapter may be stopped.
- Validator unavailable: one entry. If recoverable, the session is recreated after the settings change.
- Variant-specific execution failure: occurrences with the same cause are aggregated, and the failed-variant count is put in the evidence.
- Programming error/rejection: a safe message and the adapter ID are shown; the stack trace is kept only in the debug log.

`configuration-error` and `validator-unavailable` are treated as session-level failures. This code convention is a public contract, and the language server uses it to suppress duplicate notifications at the workspace level (language-server.md §7.3).

The same handling applies when `createSession` rejects with an `AdapterSessionFailure` (validator-api §3.1). Only that adapter is disabled, its failure is turned into a source diagnostic, and analysis by core and the other adapters continues. If `failure.recoverable` is true, session creation is retried on the next `reconfigure`. A rejection without this shape is treated as a programming error and isolated as an `execution-error`.

Even if the Markuplint adapter fails, the core diagnostics and diagnostics from other adapters are still included in the result.

## 10. Cache

### 10.1 Core result cache

Key:

```text
source hash
+ filename
+ core/compiler versions
+ normalized GenerateOptions
+ TypeScript project epoch
```

A source being edited is identified by content hash, not by mtime. "TypeScript project epoch" is `CreateWorkspaceAnalyzerOptions.typeContext.epoch` (core.md §2, ADR-0002) — a monotonic counter local to the workspace's `TypeAnalysisContext`, read fresh at cache-key-computation time on each `analyze()` call.

### 10.2 Adapter result cache

Key:

```text
adapter id/version
+ normalized settings hash
+ sourceFilename
+ HTML content hash
```

The cache belongs to a session (session-scoped). Config discovery and overrides are resolved internally by the adapter, starting from `sourceFilename`. Invalidation happens through both candidate patterns and concrete targets:

1. **Reuse within a file, across analyze calls:** the key includes `sourceFilename`, so identical HTML from different source files never shares a result (this is deliberately over-invalidating). This does not affect sharing across variants within one `analyze` call (§5.1).
2. **Invalidation on config change:** the language server watches the adapter capability's `configFilePatterns` for config candidates and the concrete paths exposed through `WorkspaceAnalyzer.getConfigWatchTargets()` (validator-api §3.1). A matching change forces recreation of that adapter's session with `reconfigure({ invalidateAdapters: [...] })` (§11). Since the cache is discarded together with the session, the "config epoch" is simply the session's generation. A dependency that the validator cannot resolve to a local path remains a documented limitation, but an arbitrary filename by itself is no longer a reason for missing invalidation.

### 10.3 Cache policy

- The initial version uses an in-memory LRU cache scoped to the workspace.
- Generated HTML and source are never written to a disk cache.
- Size is limited not only by entry count but also by an approximate character/byte count.
- Aborted or failed results are not cached. However, a deterministic configuration failure may be kept on the session.
- The relevant layer is invalidated on `reconfigure`, adapter disposal, or a TypeScript project epoch change.

## 11. Reconfigure and dispose

`reconfigure` replaces the session for the following targets, and leaves everything else unchanged:

- An adapter whose settings hash changed, based on `adapters` / `generateOptions`.
- An adapter listed in `invalidateAdapters`. This forces recreation even when the settings hash is unchanged. A config-file change that does not change the settings object (for example, editing the contents of `.markuplintrc`) can only reach the session through this route — so the language server must always pass this when it receives a watch event (language-server.md §9.3).

A `maxConcurrency` change updates the workspace validation queue for subsequently scheduled work. It does not recreate adapter sessions or discard their caches by itself.

The replacement follows these steps:

1. Create a new session.
2. Atomically swap so that subsequent `analyze` calls use the new session.
3. Dispose of the old session once analyses that reference it have completed or been aborted.

On workspace close, all analyses are aborted, the queue is closed, and every session is disposed exactly once. Even if the LSP process is force-terminated, cleanup is attempted on the normal shutdown/exit path.

## 12. Tests

Using the `adapter-testkit` fake adapter and deterministic core fixtures, the following are verified:

1. Core runs exactly once regardless of the number of adapters.
2. Work runs per variant × adapter, and identical HTML is shared within the same adapter, running only once.
3. A generated range maps back to the correct source range for static, dynamic, and synthetic attributes.
4. Fallback behavior when there is no range, no mapping, or no template.
5. Rewriting of sentinel diagnostics, and the raw message kept as evidence.
6. The same rule at different positions within one variant becomes separate occurrences.
7. The same source issue becomes one entry even if the generated offset differs across variants.
8. Issues with different source range, rule, or message/fingerprint are not merged by mistake.
9. Variant evidence is truncated at the limit.
10. An adapter failure does not cause the loss of results from other adapters or from core.
11. Bounded concurrency never exceeds its maximum.
12. After abort, no new work starts, and no result or cache entry is left behind.
13. Core/adapter cache keys and their invalidation.
14. Session swap and dispose race conditions during `reconfigure`.
15. Source/generated ranges containing emoji are kept correct in UTF-16.
16. Determinism of the virtual filename: the same `sourceFilename` and the same HTML always produce the same path, independent of variant ID or enumeration order. Different HTML produces a different path. The hash part uses only characters that are safe as a path segment.
17. `reconfigure({ invalidateAdapters })` recreates the target session even when the settings hash is unchanged, and the validation cache belonging to that session is discarded.
18. Concrete config watch targets from multiple sessions are shape-validated, tagged with the correct adapter ID, sorted/deduplicated deterministically, refreshed after validation, and removed when a session is replaced or disposed.

## 13. Open questions

Each item notes where the decision will be made.

- Whether to include a transformation group ID as a public field on core's `MappingEntry` from v1 (ADR when aggregation is implemented in Phase 2)
- Whether to add an SPI extension that lets a session expose a config fingerprint (e.g. `getConfigFingerprint(sourceFilename)`), to allow sharing the validation cache across files (ADR after measurement in Phase 2)
- Whether runtime schema validation of adapter settings is done by the language server or by the analyzer (decided during Phase 1 implementation)
- For a validator like Nu HTML Checker that requires a full document, the wrapper is added inside the adapter, and it must handle both excluding wrapper-only diagnostics and correcting ranges by itself. Whether this contract is sufficient will be verified by prototyping a second adapter. (Phase 4)
- Whether to provide an opt-in debug API (disabled by default, with an explicit privacy note since it includes source/HTML) that dumps variants, mapping, and generated HTML (ADR in Phase 2)

## 14. Proposed internal module layout

```text
src/
├── index.ts
├── workspace-analyzer.ts
├── sessions.ts
├── validation-queue.ts
├── work-deduplication.ts
├── remap.ts
├── provenance-normalizer.ts
├── aggregate.ts
├── diagnostics.ts
└── cache/
    ├── generation-cache.ts
    └── validation-cache.ts
```

`workspace-analyzer` only does orchestration. Mapping selection, provenance policy, and aggregation keys live in separate modules so each can be fixture-tested independently.
