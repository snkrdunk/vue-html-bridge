# `@vue-html-bridge/cli` Design

Status: Proposed  
Package directory: `packages/cli`

## 1. Role

A command-line client that runs the same analysis as the language server, one-shot, for CI pipelines, pre-commit hooks, and ad-hoc terminal use. It is the second consumer of `@vue-html-bridge/analyzer`, alongside the language server.

The CLI accepts the same settings as the language server: every field of `VueHtmlBridgeSettings` that is meaningful outside an editor session can be provided as a command-line flag, and the same workspace configuration files are discovered and merged with the same semantics, implemented once in `@vue-html-bridge/settings`.

### In scope

- Enumerating `.vue` files from positional arguments, `include`, and `exclude`
- Building settings from CLI flags plus the shared configuration files
- Creating one `WorkspaceAnalyzer` and running `analyze` per file
- Converting source diagnostics (UTF-16 offsets) to line/column at this boundary
- Human-readable text output and versioned machine-readable JSON output
- Exit codes for CI, a severity threshold, and SIGINT cancellation
- The same trust rules as the language server, with a CLI-appropriate default

### Out of scope

- LSP protocol, editor lifecycle, hover
- Variant generation, reverse mapping, aggregation (analyzer's job)
- Calling core or the Markuplint API directly
- Watch mode (initial release; see §10)
- Automatic fixes

Like the language server, the CLI never calls `vue-html-bridge` core directly; it always goes through the analyzer. Whatever the analyzer produces for a given source snapshot and settings is what both clients report — the E2E suite asserts that the CLI and the LSP path emit the same source diagnostics for the same fixture (§9).

## 2. Distribution and invocation

Node.js ESM, published with this bin:

```json
{
  "name": "@vue-html-bridge/cli",
  "type": "module",
  "bin": {
    "vue-html-bridge": "./dist/bin.js"
  }
}
```

```sh
vue-html-bridge [options] [file|glob ...]
```

- Positional arguments are files or globs, resolved relative to the working directory. When present, they replace the `include` setting.
- With no positional arguments, `include` (default `["**/*.vue"]`) is used, relative to the workspace root.
- stdout carries analysis results only. Logs, progress, and notices go to stderr. This mirrors the language server's rule that stdout is reserved for the protocol, and keeps `--format json` pipeable.

## 3. Dependencies

```text
cli
  ├── @vue-html-bridge/analyzer
  ├── @vue-html-bridge/adapter-markuplint   # built-in default adapter
  ├── @vue-html-bridge/validator-api        # runtime validation of external adapters
  └── @vue-html-bridge/settings             # schema, defaults, merge, decomposition, file loading
```

The CLI has no dependency on the language server or on any LSP library. Nothing in the monorepo depends on the CLI.

## 4. Settings

### 4.1 Sources and precedence

The settings model is the shared flat `VueHtmlBridgeSettings` (settings.md). The CLI composes the same layers the language server composes, with flags playing the role that `workspace/configuration` plays in the LSP:

1. Command-line flags
2. The file given by `--config <path>` (an error if missing or unparsable — the CLI never falls back silently from an explicit path)
3. The discovered `.vue-html-bridge.json` or `package.json#vueHtmlBridge` in the workspace root (skipped when `--config` is given)
4. Package defaults

Merge semantics are identical to the language server's, because both call the same `mergeSettings` in `@vue-html-bridge/settings`: objects merge field by field, arrays are fully replaced by the higher-precedence layer, unknown fields warn, and an invalid type falls back to the known safe default with a configuration error.

### 4.2 Flag mapping

Every `VueHtmlBridgeSettings` field is either mapped to a flag or explicitly listed as not applicable. This table is the parity contract; a settings field added later must extend it in the same change.

| Settings field | CLI flag | Notes |
| --- | --- | --- |
| `include` | positional arguments, or repeatable `--include <glob>` | Positional arguments and `--include` replace the config value (array replacement) |
| `exclude` | repeatable `--exclude <glob>` | Replaces the config value |
| `maxConcurrency` | `--max-concurrency <n>` | Passed to the analyzer |
| `warnVariantCount` | `--warn-variant-count <n>` | Passed to core's `GenerateOptions` |
| `customElements` | repeatable `--custom-elements <tag|glob>` | Replaces the config value |
| `externalAdapters` | `--external-adapters <disabled|trusted-workspace-only>` | See §5 |
| `validators[].enabled` | repeatable `--validator <id|package>`, repeatable `--disable-validator <id>` | See §4.3 |
| `validators[].settings` | repeatable `--validator-setting <id>.<path>=<value>` | See §4.3 |
| `enabled` | — | Gates automatic analysis in an editor. An explicit CLI invocation always runs; the field is ignored with a debug log |
| `validateOnChange`, `validateOnSave`, `debounceMs` | — | LSP document-lifecycle behavior; there is no equivalent event in a one-shot run. Accepted in config files, ignored by the CLI |

Additional CLI-only options (not part of `VueHtmlBridgeSettings`):

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Explicit settings file; replaces discovery |
| `--workspace-root <dir>` | Workspace root for config discovery, adapter sessions, and relative output paths. Default: the current working directory. One root per invocation; multi-root is an LSP concept |
| `--format <text|json>` | Output format (§7). Default `text` |
| `--fail-on <error|warning|info|hint|never>` | Lowest severity that causes exit code 1. Default `error` |
| `--untrusted` | Run with the restricted behavior of an untrusted workspace (§5) |

### 4.3 Validator flags

The `validators` array cannot be expressed as one scalar flag, and requiring users to restate the whole array on the command line would make flags useless for one-off overrides. So, as a documented exception to array replacement, the three validator flags apply **per-adapter modifications on top of the merged config layers**:

- `--validator <id|package>` marks that adapter enabled, adding an entry if none exists. The built-in adapter is addressed by its id (`markuplint`); an external adapter by its package name, subject to §5.
- `--disable-validator <id>` marks that adapter disabled.
- `--validator-setting <id>.<path>=<value>` sets one field inside that adapter's `settings`. `<path>` is a dot-separated key path; `<value>` is parsed as JSON, falling back to a plain string when parsing fails (`--validator-setting markuplint.searchConfig=false` sets a boolean; `--validator-setting markuplint.configFile=.markuplintrc` sets a string).

The flags are applied in the order given, after the config layers are merged. The CLI itself does not interpret adapter settings; it passes the resulting `settings` object through, and validation happens where it happens for the language server (the adapter-settings runtime validation decided in Phase 1).

Settings whose values cannot be written as a flag reasonably (deeply nested objects, long arrays) are expected to live in the config file; the flags exist so that everything the LSP can set is also reachable from the command line, not to make the config file unnecessary.

## 5. Trust

Running the CLI inside a repository is an explicit act — the same act as running eslint or Markuplint's own CLI — so the CLI treats the workspace as **trusted by default**: it discovers and loads the workspace's validator configuration (including JS configs and plugins) exactly as a trusted LSP workspace would.

`--untrusted` opts into the restricted behavior defined in language-server.md §4.2: the built-in Markuplint adapter runs with its bundled safe default config (no `configFile`, forced `searchConfig: false`), no external adapters are loaded, and one notice on stderr states that workspace settings are being ignored. This is intended for CI jobs that analyze untrusted contributions.

Trust never enables adapter auto-discovery. External adapters must be explicitly listed in `validators[]` (config file or `--validator <package>`), must satisfy `externalAdapters: "trusted-workspace-only"`, and go through the same runtime shape and `apiVersion` checks as in the language server (language-server.md §10.2). `--untrusted` wins over every other flag and setting.

## 6. Execution model

1. Resolve the workspace root and settings (§4); build adapters; create one `WorkspaceAnalyzer` via `createWorkspaceAnalyzer`.
2. Enumerate target files from positional arguments / `include`, minus `exclude`. The list is sorted by path so output order and JSON goldens are deterministic.
3. Read each file from disk and call `analyze` with the content as the source snapshot. There are no unsaved buffers and no document versions in a one-shot run; `documentVersion` is left unset.
4. Files are analyzed sequentially in the initial version. `maxConcurrency` still governs adapter-level parallelism inside each `analyze` call, which is where the time goes. File-level parallelism is an open question (§10).
5. Render results per file as they complete (§7), accumulate the summary, dispose the analyzer, and exit (§8).

SIGINT/SIGTERM aborts the in-flight `analyze` through its `AbortSignal`, skips remaining files, disposes sessions best-effort, and exits with the conventional signal code (130 for SIGINT). Aborted results are discarded, never rendered — cancellation is not a diagnostic (monorepo.md §11).

## 7. Output

The CLI converts source UTF-16 offsets to line/column at its boundary, the same rule the language server follows for LSP positions. Lines and columns are 1-based; columns count UTF-16 code units.

### 7.1 `--format text` (default)

One line per diagnostic, related information indented beneath it:

```text
src/components/Toggle.vue:6:19 error vue-html-bridge/non-finite-attribute-value
  Cannot narrow this attribute value to a finite set. Use a literal union allowed for aria-pressed (current type: string). [markuplint]
src/components/Menu.vue:5:11 warning invalid-attr
  The id referenced by aria-controls does not exist. (2 variants) [markuplint]
    related src/components/Menu.vue:8:24 referenced from aria-controls
```

A final summary line reports file, error, and warning counts. Color is used only when stdout is a TTY.

### 7.2 `--format json`

A single JSON document on stdout with a versioned, stable shape. It exposes both offsets (the internal contract) and line/column (for CI annotation tooling):

```jsonc
{
  "version": 1,
  "workspaceRoot": "/abs/path",
  "files": [
    {
      "path": "src/components/Toggle.vue",
      "diagnostics": [
        {
          "severity": "error",
          "code": "vue-html-bridge/non-finite-attribute-value",
          "message": "...",
          "adapterId": "markuplint",
          "origin": "validator",
          "range": { "start": 116, "end": 123 },
          "position": { "startLine": 6, "startColumn": 19, "endLine": 6, "endColumn": 26 },
          "relatedInformation": [],
          "evidence": { "variantCount": 2, "truncated": false }
        }
      ]
    }
  ],
  "summary": { "filesAnalyzed": 2, "errors": 1, "warnings": 1 }
}
```

The JSON shape follows `SourceDiagnostic` (analyzer.md §3) minus internal-only fields; like the analyzer result, it never contains generated HTML or full source text. Changes to the shape bump `version`, and the shape is pinned by golden tests. Additional formats such as SARIF are an open question (§10).

Diagnostic ordering within a file is deterministic: range, severity, source, code, message — the same order the language server publishes.

## 8. Exit codes and failures

| Exit code | Meaning |
| --- | --- |
| 0 | Analysis ran; no diagnostic at or above the `--fail-on` threshold |
| 1 | Analysis ran; at least one diagnostic at or above the threshold |
| 2 | The run itself failed: settings parse/validation error, explicit `--config` missing, no analyzable input, a session-level adapter failure (`adapter/<id>/configuration-error`, `validator-unavailable`), or an internal error |
| 130 | Interrupted (SIGINT) |

Session-level adapter failures are exit code 2 even though the analyzer also reports them as source diagnostics — a misconfigured CI job must not pass as "no findings". Per-file core diagnostics and per-variant execution failures are ordinary results and follow `--fail-on`. `--fail-on never` reports everything but always exits 0/2, for jobs that only collect output.

## 9. Tests

1. Flag → settings decomposition parity: a fixture table covering every `VueHtmlBridgeSettings` field asserts that the flag layer produces the same merged settings as the equivalent config file (shared fixtures with `@vue-html-bridge/settings`).
2. Precedence: flags > `--config` > discovered file > defaults; explicit `--config` failure exits 2 without fallback.
3. `--validator-setting` parsing: dotted paths, JSON values, string fallback, application order, unknown adapter id.
4. File enumeration: positional args replace `include`, `exclude` applies, ordering is deterministic, no matches exits 2 with a clear message.
5. Text output golden, including related information and the summary line.
6. JSON output golden; `JSON.parse` round-trip; `version` present; no generated HTML or source text embedded.
7. Offset → line/column conversion at the boundary: CRLF, emoji, zero-width ranges (same fixture family as language-server §13.1).
8. Exit codes: threshold interactions with `--fail-on`, session-level adapter failure → 2, `--fail-on never`.
9. SIGINT mid-analysis: in-flight analyze aborted, no partial rendering for the aborted file, exit 130, sessions disposed.
10. `--untrusted`: bundled Markuplint defaults are used, workspace config/plugins are not read, external adapters are not loaded — behavior matches the language server's restricted session on the same fixture.
11. External adapter loading: same allowlist/runtime-shape/apiVersion gates as the language server; a load failure disables only that adapter and is reported once.
12. E2E parity: on the language-server §13.3 fixture, the CLI reports the same source diagnostics (code, range, severity, adapterId) as the LSP path.

## 10. Open questions

Each item notes where the decision will be made.

- Watch mode (`--watch`): overlaps with LSP debounce/cancellation machinery; decide after the initial release based on demand (ADR)
- SARIF or other CI-native output formats, on top of JSON v1 (ADR after initial-release feedback)
- stdin input (`--stdin --stdin-filename <path>`) for editor-less integrations (decide when requested)
- File-level parallel `analyze` on top of adapter-level concurrency (after the Phase 2 performance measurements)
- A persistent cross-run cache. analyzer.md §10.3 forbids writing generated HTML or source to disk, so any persistent cache needs its own design and privacy review (ADR; do not implement casually)

## 11. Proposed internal module layout

```text
src/
├── bin.ts            # entry point; signal handling; exit codes
├── cli.ts            # argument parsing; help text
├── options.ts        # flag ↔ VueHtmlBridgeSettings mapping (the §4.2 table)
├── runner.ts         # file enumeration; analyzer lifecycle; per-file analyze
├── line-index.ts     # offset → line/column at the output boundary
├── output/
│   ├── text.ts
│   └── json.ts
└── exit-codes.ts
```

`options.ts` contains the only knowledge of the flag surface; `runner.ts` knows nothing about flags and takes a resolved `VueHtmlBridgeSettings`. Output modules take fully converted positions and never see the analyzer types beyond `SourceDiagnostic`.
