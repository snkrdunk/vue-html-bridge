# `@vue-html-bridge/language-server` Design

Status: Proposed  
Package directory: `packages/language-server`

## 1. Role

This package converts the source diagnostics from `@vue-html-bridge/analyzer` into [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) 3.18 messages. It is an editor-neutral language server that any LSP-capable editor can use.

### In scope

- JSON-RPC/LSP connection and server capabilities
- Open/change/save/close lifecycle for text documents
- Keeping unsaved buffers, debounce, cancellation, document version gating
- Reading and watching workspace folders and settings
- Building the built-in Markuplint adapter and any explicitly configured external adapters
- Converting between source UTF-16 offsets and LSP Position/Range
- Publishing diagnostics, hover responses, related information
- Analyzer/session lifecycle per workspace

### Out of scope

- Processing the Vue compiler AST
- Variant generation, reverse mapping, cross-variant aggregation
- Calling the Markuplint API directly
- Editor-specific UI, extensions, or Problems navigation
- Automatic fixes to the source

## 2. Distribution and startup

This package is distributed as Node.js ESM and exposes this bin:

```json
{
  "name": "@vue-html-bridge/language-server",
  "type": "module",
  "bin": {
    "vue-html-bridge-language-server": "./dist/bin.js"
  }
}
```

The initial transport is stdio.

```sh
vue-html-bridge-language-server --stdio
```

stdout is reserved for JSON-RPC only. Logs go to the LSP connection's `window/logMessage` or to stderr; the server never writes arbitrary strings to stdout. Socket/Node IPC transport will be added once tests or future editor integrations need it.

The package also exposes a library entry point, so integration tests can use an in-memory connection.

```ts
export interface StartLanguageServerOptions {
  connection: Connection;
  fileSystem?: ServerFileSystem;
  moduleResolver?: AdapterModuleResolver; // passed through to @vue-html-bridge/adapter-loader
  logger?: ServerLogger;
}

export function startLanguageServer(
  options: StartLanguageServerOptions,
): LanguageServerHandle;
```

## 3. Dependencies

```text
language-server
  ├── @vue-html-bridge/analyzer
  ├── @vue-html-bridge/adapter-markuplint
  ├── @vue-html-bridge/validator-api (runtime adapter validation)
  ├── @vue-html-bridge/adapter-loader (shared external-adapter loading and trust gating)
  ├── @vue-html-bridge/settings (schema, resolution, decomposition, workspace-file loading)
  └── vscode-languageserver / vscode-languageserver-textdocument
```

The language server never calls `vue-html-bridge` core directly; it always goes through the analyzer. The Markuplint adapter is a direct dependency because it is the initial default adapter. External adapters are loaded dynamically through workspace resolution.

## 4. Initialize

### 4.1 Server capabilities

The initial version returns roughly this:

```ts
const capabilities: ServerCapabilities = {
  positionEncoding: negotiatedPositionEncoding,
  textDocumentSync: TextDocumentSyncKind.Incremental,
  hoverProvider: true,
  workspace: {
    workspaceFolders: {
      supported: true,
      changeNotifications: true,
    },
  },
};
```

- Diagnostics use the widely supported `textDocument/publishDiagnostics`.
- Pull diagnostics (`textDocument/diagnostic`) are not declared in the initial version.
- Completion, definition, references, formatting, and codeAction are not declared.
- This server handles the same `.vue` files as the Vue language server, but runs as a separate server alongside it. It does not reimplement Vue/TypeScript language features.

### 4.2 Initialization options

The server accepts only the values that are client-specific and are needed before LSP settings arrive.

```ts
export interface VueHtmlBridgeInitializationOptions {
  /** Whether the client allows running external adapter/config code. */
  workspaceTrusted?: boolean; // default: false

  /** Initial values, used when the client cannot fetch explicit settings yet. */
  settings?: VueHtmlBridgeSettingsInput;
}
```

LSP itself has no workspace trust protocol that all clients agree on, so permission to run external code must be given explicitly through initialization options or settings. If not specified, it defaults to false. Trust is required even when only the built-in Markuplint adapter is used, if that adapter needs to load the workspace's Markuplint JS config or plugins. In an untrusted workspace, the built-in Markuplint adapter runs with its bundled, safe default config. It does not load the workspace's config search, JS config, or plugins (the adapter settings force no `configFile` plus `searchConfig: false`), and the server shows one notice per workspace saying that the workspace validator configuration and external adapters are being ignored (host-neutral bridge settings such as `include`/`exclude` still apply). No external adapters are loaded.

## 5. Position encoding

The analyzer returns UTF-16 absolute offsets in the source. The language server converts these to LSP Position at its boundary.

1. If the client's `general.positionEncodings` includes UTF-16, or if the client sends no capability at all, the server picks UTF-16.
2. If the client does not offer UTF-16 and offers only UTF-8/UTF-32, the server uses a matching converter and returns that encoding in `ServerCapabilities.positionEncoding`.
3. If the initial implementation cannot provide a non-UTF-16 converter, it should not fail with an initialize error; instead it should investigate compatibility further, but it must never claim to support an encoding it does not actually support. Phase 0 will settle the target client matrix.

The server builds a line index for each document version.

```ts
interface PositionIndex {
  offsetToPosition(offset: number, encoding: PositionEncodingKind): Position;
  positionToOffset(position: Position, encoding: PositionEncodingKind): number;
}
```

- Before clamping an offset to `[0, source.length]`, the server logs the out-of-range value to the server log.
- CRLF is treated as a single line break.
- A range that points into the middle of a surrogate pair is treated as an upstream bug; the server does not silently round it to the nearest code unit boundary.
- Zero-width diagnostics are also converted into a valid LSP Range.

## 6. Document lifecycle

The server keeps this state per URI:

```ts
interface DocumentAnalysisState {
  version: number;
  debounceTimer?: Disposable;
  abortController?: AbortController;
  lastPublishedVersion?: number;
  diagnostics: readonly CachedSourceDiagnostic[];
  positionIndex: PositionIndex;
}
```

### 6.1 didOpen

- Keeps the text/version sent by the client.
- Determines the matching workspace folder.
- Schedules analysis with a default debounce of 0 ms, or a short debounce.

### 6.2 didChange

- Applies incremental changes in order, and determines the new text/version.
- Discards any pending timer and aborts any analysis in progress.
- Analyzes the latest snapshot after the default `debounceMs: 200`.
- To avoid a case where the user keeps typing and analysis never runs, a future `maxDebounceMs` option can be added.

### 6.3 didSave

- If `validateOnSave` is true, re-analyzes immediately without waiting for the debounce.
- The source comes from the client buffer; the server does not re-read from the filesystem after a save.
- If a config/type project epoch update is needed, it notifies the analyzer session.

### 6.4 didClose

- Discards the timer and aborts analysis.
- Clears the display by publishing `publishDiagnostics({ uri, diagnostics: [] })`.
- Discards the document state and the position/hover cache.

### 6.5 Stale result suppression

```ts
const snapshot = { uri, version: document.version, text: document.getText() };
const controller = new AbortController();
state.abortController = controller;

const result = await analyzer.analyze({
  uri: snapshot.uri,
  filename,
  source: snapshot.text,
  documentVersion: snapshot.version,
  signal: controller.signal,
});

if (controller.signal.aborted) return;
const current = documents.get(uri);
if (!current || current.version !== snapshot.version) return;
if (state.abortController !== controller) return;

publish(result, current);
```

The server does not rely only on AbortSignal; it also checks both the version and the controller identity. This way, a slow result from a validator that has no native cancellation is still never published.

## 7. Diagnostics

### 7.1 Conversion

```ts
function toLspDiagnostic(
  source: string,
  index: PositionIndex,
  diagnostic: SourceDiagnostic,
): Diagnostic {
  return {
    range: toLspRange(index, diagnostic.sourceRange),
    severity: toLspSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.adapterId
      ? `vue-html-bridge/${diagnostic.adapterId}`
      : "vue-html-bridge",
    code: diagnostic.code,
    codeDescription: diagnostic.codeDescriptionHref
      ? { href: diagnostic.codeDescriptionHref }
      : undefined,
    relatedInformation: toRelatedInformation(diagnostic.relatedInformation),
    data: { diagnosticId: diagnostic.id },
  };
}
```

- Error/warning/info/hint map to the matching LSP `DiagnosticSeverity`.
- `source` and `code` distinguish a core/adapter failure from a validator violation.
- `data` holds only a short ID for cache lookup; it never carries the full variant or generated HTML text.
- Related information needs the source text to convert a source range to a line/column, even when the other URI is not an open document. Since the initial version only maps within the same SFC, related information is restricted to the same URI. A file snapshot provider will be added later, when component expansion is supported.

### 7.2 Publish

```ts
connection.sendDiagnostics({
  uri,
  version: result.documentVersion,
  diagnostics,
});
```

The order is deterministic, based on range, severity, source, code, and message. If a single publish would exceed a client's practical limit, the server should not just send the first N. Since the analyzer already aggregates by source identity, a future version may add a configurable display cap plus a "remaining count" diagnostic.

Since the standard `Diagnostic.range` and URI are present, the client already provides jump-to-location from the Problems UI and next/previous diagnostic navigation. This server does not add a custom jump request.

### 7.3 Workspace/config failure

Server initialization/config errors that do not map to one specific source file are reported through `window/showMessage` and `window/logMessage`. An adapter failure that happened while analyzing one specific `.vue` file is published as a normal diagnostic, because the analyzer places it at the template range. To avoid flooding every open file with copies of the same session-level failure, the server shows one notice per workspace, and places at most one diagnostic per document only where needed. Whether a failure is session-level is identified from the analyzer's code convention (`adapter/<adapter-id>/configuration-error`, `adapter/<adapter-id>/validator-unavailable`; see analyzer.md §9.2).

## 8. Hover

The server caches, per URI/version, the same `SourceDiagnostic` list it used to publish diagnostics. For `textDocument/hover`, it converts the request position to a source offset and looks up a diagnostic using these rules:

- Non-empty range: `start <= offset < end`
- Zero-width range: offset equals start
- If several diagnostics match the same point: order by severity, then by shorter range, then by source/code.

Example hover content:

```md
**Markuplint · invalid-attr**

The value of `aria-pressed` is invalid.

Occurs in 2 variants: `loggedIn=true`, `role="admin"`

[Open rule description](https://markuplint.dev/docs/rules/invalid-attr)
```

For diagnostics rewritten from a sentinel, the bridge's own explanation is shown first. The original validator message follows, as a short "Validator detail" section, so it stays readable even in an LSP client that cannot collapse long text. Validator detail shows one representative message plus a count of the rest. Message length is not limited in the initial version, but it is measured, so a future version can decide whether a limit is needed. Evidence has an upper bound (analyzer.md §3); hover never lists the full cross-product of all decisions.

At a position with no diagnostic, the server returns `null`. It does not return generic information that would compete with hover from the Vue language server or similar tools.

## 9. Workspace and settings

### 9.1 Multi-root

- Each workspace folder has its own config, adapter sessions, analyzer, and cache.
- A `.vue` URI belongs to the folder whose path is the longest matching prefix.
- A single file outside any folder uses a restricted default session, which does not load external adapters or config.
- On `workspace/didChangeWorkspaceFolders`, the server creates sessions for added folders and aborts/disposes analysis for removed folders.

### 9.2 Settings

The settings schema is the shared flat pair `VueHtmlBridgeSettingsInput` / `ResolvedVueHtmlBridgeSettings`, owned by `@vue-html-bridge/settings` (settings.md §3) together with its defaults, layer resolution, and decomposition into per-package options. The language server does not redefine any of that; this section covers only what is LSP-specific.

Settings precedence (the host layer of settings.md §4):

1. `vueHtmlBridge` from LSP `workspace/configuration`
2. `.vue-html-bridge.json` or `package.json#vueHtmlBridge`, loaded through the shared loader (settings.md §5)
3. Defaults

Resolution semantics are those of `resolveSettings` (settings.md §4): each layer is validated first (an unknown field warns and is dropped; an invalid value is an error and is pinned to the package default for the whole resolution), then the layers merge with full array replacement. The server always continues with the resolved settings — a broken settings file degrades analysis, it never turns the editor dark — and reports the returned issues once per workspace via `window/logMessage` / `window/showMessage`. (The CLI intentionally differs: error issues abort its run — cli.md §8.)

The server routes values with `decomposeSettings` (settings.md §6): `warnVariantCount` / `customElements` to core's `GenerateOptions` through the analyzer; `maxConcurrency` to the analyzer's `CreateWorkspaceAnalyzerOptions` / `ReconfigureOptions`; `validators[].settings` to each adapter's `AdapterSessionContext.settings`; and the host fields (`enabled`, `include`/`exclude`, `validateOn*`, `debounceMs`, `externalAdapters`) to its own scheduling and trust logic. The CLI consumes the same schema with flags as its host layer (cli.md §4), so a new settings field must be routed in settings.md's decomposition table — pinned by a parity fixture both hosts' test suites reuse — rather than in either host.

`schema.json` continues to ship in this package for existing `$schema` references; it is generated at build time from `@vue-html-bridge/settings` (settings.md §7), never edited by hand.

### 9.3 Settings changes

- If the client supports dynamic registration, the server registers the bridge settings files and each enabled adapter's `configFilePatterns` (validator-api §3). These globs detect config candidates, including a nearer config created after the session was initialized.
- After analyzer creation/reconfiguration and after each analysis, the server reads `analyzer.getConfigWatchTargets()`. It diffs the deterministic snapshot against the current registrations and watches the concrete absolute paths reported by sessions, including explicit configs and resolved `extends`/plugin dependencies. The language server never inspects `validators[].settings` for a validator-specific field such as `configFile`; adapters expose those paths through the SPI instead.
- On a candidate-pattern or concrete-target event, the server calls `analyzer.reconfigure({ invalidateAdapters: [<matching adapter id>] })`. The settings object itself does not change in this case, so without this forced flag the session would not be recreated and its session-scoped validation cache would remain stale. After replacement, the concrete-target registrations are refreshed from the new session snapshot.
- On `workspace/didChangeConfiguration`, the server re-fetches settings.
- It aborts any analysis in progress for the changed workspace, calls `reconfigure` on the analyzer, and re-analyzes open documents.
- If a config file has a parse error mid-save, one option under consideration is to keep the previous session, report the error, and retry on the next change, instead of silently switching to a different config.

## 10. Adapter loading and trust

### 10.1 Built-in adapter

`@vue-html-bridge/adapter-markuplint` is imported from the server's own dependencies; it does not rely on workspace package resolution. However, workspace trust is still required if it needs to read the workspace's Markuplint config/plugins.

### 10.2 External adapter

An external adapter is loaded only if all of the following hold:

1. The package name is explicitly given in `validators[].adapter` in settings.
2. `externalAdapters === "trusted-workspace-only"`.
3. Workspace trust is explicitly granted, through initialization options or settings.
4. The package resolves through that workspace's Node resolution.
5. Its export matches the `HtmlValidatorAdapter` runtime shape and has `apiVersion === 1`.

The initial version does not accept an arbitrary absolute path, URL, or data URI. A package name must be a plain npm package specifier, similar to an allowlist. The server never automatically enumerates or executes anything under `node_modules`.

These gates and the loading itself are implemented once in `@vue-html-bridge/adapter-loader` (adapter-loader.md), shared with the CLI, so the two hosts cannot drift on security-sensitive behavior. The server injects the built-in adapter, the workspace module resolver, and the trust state, and keeps only the presentation: it converts the loader's structured failures (resolution failure, invalid runtime shape, `apiVersion` mismatch, import-time throw, duplicate runtime id) into per-workspace notices deduplicated by the loader's `dedupeKey`, and retries on `workspace/didChangeConfiguration`. Failures stay isolated per adapter: only the failing adapter is disabled; the built-in adapter and other external adapters keep running.

Dynamic import, Markuplint JS config/plugins, and a future Nu subprocess all amount to running workspace code. This is documented explicitly as a trust boundary, not a security boundary.

TypeScript/Vue type analysis sits outside this trust boundary. It only reads tsconfig and type definition files as data; it never runs a TS language service plugin or a custom transformer (core.md §2). Type analysis is not restricted even in an untrusted workspace. However, the analysis cache of the restricted session used for a single file outside any folder is not shared with normal sessions.

## 11. Logging and privacy

- The default log level is info. Individual variant HTML is not logged.
- Source text, generated HTML, and attribute values are never sent to telemetry.
- Telemetry is not implemented in the initial version.
- Timing/stats can go to the debug log with the URI turned into a workspace-relative path.
- Adapter error stacks stay in the debug log only; LSP diagnostics use a safe message instead.
- stdout is never used for logging.

## 12. Shutdown

On a `shutdown` request:

1. Stop scheduling new analysis.
2. Cancel all timers and all AbortControllers.
3. Dispose all workspace analyzers.
4. Diagnostics do not need to be cleared explicitly, but test transports should check the client state.

On `exit`, the server returns code 0 if shutdown already happened, and otherwise follows the usual LSP convention. It also makes a best-effort dispose on a process signal, but never blocks the exit with a long synchronous cleanup.

## 13. Testing

### 13.1 Unit

1. UTF-16/UTF-8/UTF-32 position conversion, CRLF, emoji, zero-width.
2. Mapping from SourceDiagnostic to LSP Diagnostic: severity/code/source/related.
3. Hover hit testing, ordering of multiple diagnostics, evidence truncation.
4. Settings resolution via `resolveSettings`: layer order, array replacement, invalid/unknown fields, continue-with-fallback behavior.
5. Workspace folder routing and the single-file restricted session.
6. External adapter loading through the shared loader: the adapter-loader contract fixture, notice deduplication by `dedupeKey`, retry on configuration change.
7. Candidate-pattern and concrete-target watcher snapshots are registered, refreshed, and mapped back to the adapter whose session must be recreated, without inspecting adapter-specific settings.

### 13.2 Protocol integration

Using an in-memory JSON-RPC connection, test:

1. Initialize capability and negotiated position encoding.
2. Diagnostics published after didOpen.
3. Incremental didChange and analysis of unsaved text.
4. A single run when several changes arrive during the debounce window.
5. Version 1's diagnostics are never published if version 1 finishes slowly after version 2 already completed.
6. Empty diagnostics published on didClose.
7. Hover returns the same message/evidence as the published version.
8. Session recreation and open document re-analysis on a workspace config change.
9. Different config/adapters in a multi-root workspace do not mix.
10. Analyzer/sessions are disposed on shutdown.
11. A concrete config target discovered by an adapter after analysis is dynamically registered; changing it recreates only that adapter's session and refreshes the target snapshot.

### 13.3 End-to-end

Using real core plus the Markuplint adapter, verify that a Markuplint violation in a fixture `.vue` file is published at the correct LSP line/column.

```vue
<script setup lang="ts">
const props = defineProps<{ loggedIn: boolean }>();
</script>
<template>
  <nav v-if="props.loggedIn" id="user-menu" />
  <button :aria-controls="props.loggedIn ? 'missing' : undefined">Menu</button>
</template>
```

- The violation only happens in the relevant variant.
- The diagnostic range maps back to the `:aria-controls` expression or value.
- Hover shows the Markuplint rule and the variant evidence.
- The URI/range needed for Problems navigation is included.

## 14. Open Questions

Each item lists where the decision will be made.

- Whether to bundle a minimal client launcher in the language server package, or ship it as a separate package (decided at Phase 3's initial release)
- Which client/version conditions justify adding pull diagnostics (ADR after Phase 2 measurements)
- Whether to run TypeScript/Vue project service and core execution in a separate worker thread (core's public API is already async, so callers do not change even if this moves later; decided from Phase 0 response-time measurements; monorepo.md §14)
- Finer-grained trust levels depending on config format (JSON vs. JS). The initial version uses all-or-nothing (ADR once this is requested)
- How long to keep the last-known-good session after a config parse error (decided during Phase 2 implementation)
- Package specifier allowlist and PnP support for external adapter loading (Phase 3)
- Initial support scope when an LSP client does not offer UTF-16 (settled by the Phase 0 client matrix)

## 15. References

- [Language Server Protocol 3.18](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)
- [Vue Language Tools](https://github.com/vuejs/language-tools)

## 16. Proposed internal module layout

```text
src/
├── bin.ts
├── server.ts
├── documents.ts
├── diagnostics.ts
├── hover.ts
├── positions.ts
├── config/
│   ├── sources.ts    # layers workspace/configuration onto @vue-html-bridge/settings
│   └── watcher.ts
├── workspace/
│   ├── manager.ts
│   └── session.ts
└── adapters/
    ├── loading.ts    # thin wrapper over @vue-html-bridge/adapter-loader; failure → notice conversion
    └── trust.ts
```

`server.ts` is limited to wiring protocol handlers. Document version races are confined to `documents.ts`, and workspace/analyzer lifecycle is confined to `workspace/session.ts`.
