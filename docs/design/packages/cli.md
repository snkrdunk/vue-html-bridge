# `@vue-html-bridge/cli` Design

Status: Implemented  
Package directory: `packages/cli`

## 1. Role

A command-line client that runs the same analysis as the language server, one-shot, for CI pipelines, pre-commit hooks, and ad-hoc terminal use. It is the second consumer of `@vue-html-bridge/analyzer`, alongside the language server.

The CLI accepts the same settings as the language server: every field of the shared settings schema that is meaningful outside an editor session can be provided as a command-line flag, and the same workspace configuration files are discovered and resolved with the same semantics, implemented once in `@vue-html-bridge/settings`. External adapters are loaded and gated by the same shared implementation, `@vue-html-bridge/adapter-loader`.

### In scope

- Enumerating `.vue` files from positional arguments, `include`, and `exclude`
- Building settings layers from CLI flags and the shared configuration files, resolved by `resolveSettings`
- Loading adapters through `@vue-html-bridge/adapter-loader`, creating one `WorkspaceAnalyzer`, and running `analyze` per file
- Converting source diagnostics (UTF-16 offsets) to line/column at this boundary
- Human-readable text output and versioned machine-readable NDJSON output
- A run outcome model: exit codes, a severity threshold, run-level errors, and signal handling
- The same trust rules as the language server, with a CLI-appropriate default

### Out of scope

- LSP protocol, editor lifecycle, hover
- Variant generation, reverse mapping, aggregation (analyzer's job)
- Calling core or the Markuplint API directly
- Watch mode and stdin input (scoped out through Phase 3, per product decision 2026-08-21; see §10)
- Automatic fixes

Like the language server, the CLI never calls `vue-html-bridge` core directly; it always goes through the analyzer. Whatever the analyzer produces for a given source snapshot and settings is what both clients report — the E2E suite asserts that the CLI and the LSP path emit the same source diagnostics for the same fixture under an explicitly equalized trust policy and resolved settings (§9).

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
vue-html-bridge [options] [file|dir|glob ...]
```

- Positional arguments are files, directories, or globs, resolved relative to the working directory. A directory argument expands to `<dir>/**/*.vue`. When positional arguments are present, they replace the `include` setting.
- With no positional arguments, `include` (default `["**/*.vue"]`) is used, relative to the workspace root.
- stdout carries analysis results only. Logs, progress, and notices go to stderr. This mirrors the language server's rule that stdout is reserved for the protocol, and keeps `--format ndjson` pipeable.
- `--help` and `--version` print to stdout and exit 0. An unknown option or a malformed value prints usage to stderr and exits 2.

## 3. Dependencies

```text
cli
  ├── @vue-html-bridge/analyzer
  ├── @vue-html-bridge/adapter-markuplint   # built-in default adapter
  ├── @vue-html-bridge/adapter-loader       # shared external-adapter loading and trust gating
  ├── @vue-html-bridge/validator-api        # SPI types
  └── @vue-html-bridge/settings             # schema, resolution, decomposition, file loading
```

The CLI has no dependency on the language server or on any LSP library. Nothing in the monorepo depends on the CLI.

## 4. Settings

### 4.1 Sources and precedence

The settings model is the shared schema (settings.md §3): each source below contributes one `VueHtmlBridgeSettingsInput` layer, and `resolveSettings` (settings.md §4) validates and merges them. Flags play the role that `workspace/configuration` plays in the LSP:

1. Command-line flags
2. The file given by `--config <path>` — resolved from the current working directory, loaded through the shared `loadSettingsFile` (settings.md §5). The file contains the settings object itself. `file-missing`, `file-unreadable`, and `parse-error` on an explicit path are all fatal (exit 2); the CLI never falls back silently from an explicit path.
3. The discovered `.vue-html-bridge.json` or `package.json#vueHtmlBridge` in the workspace root, via `loadWorkspaceSettingsFile` (skipped when `--config` is given)
4. Package defaults (settings.md §3.1)

Resolution semantics — per-layer validation, invalid values pinned to safe defaults, array replacement — are exactly those of `resolveSettings`; the CLI adds nothing. What the CLI decides is what to do with the issues: **`error` issues are fatal and stop the run before any analysis (exit 2, stderr)**; `warning` issues are printed to stderr and the run continues. This intentionally differs from the language server, which continues with the resolved fallback values so the editor never goes dark; CI, by contrast, must fail loudly on misconfiguration.

### 4.2 Flag mapping

Every settings field is either mapped to a flag or explicitly listed as not applicable. This table is the parity contract; a settings field added later must extend it in the same change.

| Settings field | CLI flag | Notes |
| --- | --- | --- |
| `include` | positional arguments, or repeatable `--include <glob>` | Positional arguments and `--include` replace the config value (array replacement) |
| `exclude` | repeatable `--exclude <glob>` | Replaces the config value (default: `["**/node_modules/**"]`) |
| `maxConcurrency` | `--max-concurrency <n>` | Passed to the analyzer |
| `warnVariantCount` | `--warn-variant-count <n>` | Passed to core's `GenerateOptions` |
| `customElements` | repeatable `--custom-elements <tag|glob>` | Replaces the config value |
| `customDirectives` | — | Config-file only (core.md §5.3.1, ADR-0010). Like `validators[].settings`, this field is at least as rich as `validators[]` (nested per-item object with its own value-template grammar); `validators[]` needed three dedicated flags plus dotted-path/deep-set machinery for a comparably rich field, and cli.md's own guidance is that nested/rich fields belong in the config file |
| `externalAdapters` | `--external-adapters <disabled|trusted-workspace-only>` | See §5 |
| `validators[].enabled` | repeatable `--validator <entry-key>`, repeatable `--disable-validator <entry-key>` | See §4.3 |
| `validators[].settings` | repeatable `--validator-setting <entry-key>.<path>=<value>` | See §4.3 |
| `enabled` | — | Gates automatic analysis in an editor. An explicit CLI invocation always runs; the field is ignored with a debug log |
| `validateOnChange`, `validateOnSave`, `debounceMs` | — | LSP document-lifecycle behavior; there is no equivalent event in a one-shot run. Accepted in config files, ignored by the CLI |

Additional CLI-only options (not part of the settings schema):

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Explicit settings file; replaces discovery (§4.1) |
| `--workspace-root <dir>` | Workspace root for config discovery, adapter sessions, the file-enumeration boundary, and relative output paths. Default: the current working directory. One root per invocation; multi-root is an LSP concept |
| `--format <text|ndjson>` | Output format (§7). Default `text` |
| `--fail-on <error|warning|info|hint|never>` | Lowest severity that causes exit code 1. Default `error` |
| `--untrusted` | Run with the restricted trust behavior (§5) |
| `--help`, `--version` | Print and exit 0 |
| `--no-color` | Disable color. Color is used only when stdout is a TTY and the `NO_COLOR` environment variable is unset |

### 4.3 Validator flags

The `validators` array cannot be expressed as one scalar flag, and requiring users to restate the whole array on the command line would make flags useless for one-off overrides. So, as a documented exception to array replacement, the three validator flags apply **per-entry modifications on top of the resolved config layers**, in the order given:

- `--validator <entry-key>` marks that entry enabled, adding an entry if none exists.
- `--disable-validator <entry-key>` marks that entry disabled.
- `--validator-setting <entry-key>.<path>=<value>` sets one field inside that entry's `settings`. `<value>` is parsed as JSON, falling back to a plain string when parsing fails (`--validator-setting markuplint.searchConfig=false` sets a boolean; `--validator-setting markuplint.configFile=.markuplintrc` sets a string).

**Entry identification.** `<entry-key>` is the exact `validators[].adapter` string from the settings — the built-in adapter's stable id (`markuplint`) or an external package specifier (settings.md §3.1) — never the runtime `adapter.id` an external package exports. Flags therefore address config entries deterministically before anything is loaded. Duplicate entries with the same key are a settings error (settings.md §4); two *loaded* adapters exposing the same runtime id are a run-level error handled by the adapter loader (adapter-loader.md).

**Dotted path grammar.** `<path>` is one or more non-empty segments separated by `.`. Array indices are not supported in v1, and a key that itself contains a literal `.` cannot be addressed by flag — use the config file for both. The segments `__proto__`, `constructor`, and `prototype` are rejected with an error, and the implementation must build the nested value with own-property assignment on null-prototype objects, so `--validator-setting` can never pollute prototypes (§9).

The CLI itself does not interpret adapter settings; it passes the resulting `settings` object through, and validation happens where it happens for the language server (the adapter-settings runtime validation decided in Phase 1).

Settings whose values cannot be written as a flag reasonably (deeply nested objects, long arrays) are expected to live in the config file; the flags exist so that everything the LSP can set is also reachable from the command line, not to make the config file unnecessary.

## 5. Trust

Running the CLI inside a repository is an explicit act — the same act as running eslint or Markuplint's own CLI — so the CLI treats the workspace as **trusted by default**: it discovers and loads the workspace's validator configuration (including JS configs and plugins) exactly as a trusted LSP workspace would.

`--untrusted` restricts exactly the settings that can cause workspace code to run, mirroring language-server.md §4.2:

- **Forced:** `externalAdapters` is treated as `"disabled"`, and the built-in Markuplint adapter runs with its bundled safe default config (no `configFile`, forced `searchConfig: false`, no workspace JS config or plugins).
- **Unaffected:** every host-neutral setting keeps its normal precedence — file selection (`include`/`exclude`/positional args), `maxConcurrency`, `warnVariantCount`, `customElements`, `customDirectives`, output format, `--fail-on`, and exit behavior. Declaring a `customDirectives` mapping never runs code — it is a declarative value template evaluated by core's existing side-effect-free expression evaluator (core.md §5.3.1) — so trust never gates it.

One stderr notice states that *workspace validator configuration and external adapters* are being ignored — not the bridge settings as a whole. `--untrusted` wins over any conflicting trust-related flag or setting (for example an explicit `--external-adapters trusted-workspace-only`); it does not override anything else. This mode is intended for CI jobs that analyze untrusted contributions.

Trust never enables adapter auto-discovery. External adapters must be explicitly listed in `validators[]` (config file or `--validator <package>`), must satisfy `externalAdapters: "trusted-workspace-only"`, and pass the specifier, runtime-shape, and `apiVersion` gates. All of that gating is implemented once in `@vue-html-bridge/adapter-loader` (adapter-loader.md) and shared with the language server; the CLI only converts the loader's structured failures into stderr messages and run-level errors (§8).

## 6. Execution model

1. Resolve the workspace root and settings (§4); load adapters through the shared loader; create one `WorkspaceAnalyzer` via `createWorkspaceAnalyzer`.
2. Enumerate target files:
   - Sources: positional arguments (files, directories expanded to `<dir>/**/*.vue`, globs) or `include`, minus `exclude`. Globs follow standard semantics: `*` does not match dotfiles; `node_modules` is skipped via the default `exclude`.
   - **Workspace boundary:** every resolved file must lie inside the workspace root. A positional argument that resolves outside it (`../other/File.vue`) is a run-level error (§8) in the initial version — config discovery, adapter sessions, and relative output paths are all defined against one root. Widening this is a later decision.
   - **Identity and deduplication:** each path is normalized to its absolute real path (symlinks resolved; case normalized on case-insensitive filesystems). Two arguments reaching the same real path analyze it once.
   - The final list is sorted by path so output order and NDJSON goldens are deterministic.
3. Read each file from disk and call `analyze` with the content as the source snapshot. `AnalyzeRequest.uri` is built from the resolved absolute real path with Node's `pathToFileURL` (its Windows drive-letter and percent-encoding rules are the contract), so the same file always yields the same URI. There are no unsaved buffers and no document versions in a one-shot run; `documentVersion` is left unset. A file read error is a run-level error; remaining files are still analyzed.
4. Files are analyzed sequentially in the initial version. `maxConcurrency` still governs adapter-level parallelism inside each `analyze` call, which is where the time goes. File-level parallelism is an open question (§10).
5. Rendering depends on the output mode: both `--format text` and `--format ndjson` render each file's results as they complete (streaming) — NDJSON's line-delimited shape is exactly what makes this safe: unlike a single buffered document, a consumer can process each line as it arrives (§7.2). Then the analyzer is disposed and the process exits per §8.

**Signals.** SIGINT and SIGTERM abort the in-flight `analyze` through its `AbortSignal`, skip remaining files, dispose sessions best-effort, and exit with the conventional code — 130 for SIGINT, 143 for SIGTERM. Cleanup is bounded and never blocks exit indefinitely (the same rule as language-server.md §12); a second signal during cleanup exits immediately. Aborted results are discarded, never rendered — cancellation is not a diagnostic (monorepo.md §11) — and in NDJSON mode an interrupted run's stream simply stops after the last completed line, with no `summary` line (§7.2).

## 7. Output

The CLI converts source UTF-16 offsets to line/column at its boundary, the same rule the language server follows for LSP positions. Lines and columns are 1-based; columns count UTF-16 code units. The conversion fixtures (CRLF, emoji, zero-width) are shared with the language server's §13.1 suite; the implementation itself may be duplicated between the hosts until measured need justifies extracting a utility package.

All paths in output are workspace-relative and use `/` separators on every platform: CI artifacts stay reproducible across machines and do not embed absolute paths from the build host. (Files outside the workspace root never appear — §6 rejects them.)

Diagnostic ordering within a file is deterministic: range, severity, origin, `adapterId`, code, message.

### 7.1 `--format text` (default)

One line per diagnostic, related information indented beneath it:

```text
src/components/Toggle.vue:6:19 error vue-html-bridge/non-finite-attribute-value
  Cannot narrow this attribute value to a finite set. Use a literal union allowed for aria-pressed (current type: string). [markuplint]
src/components/Menu.vue:5:11 warning invalid-attr
  The id referenced by aria-controls does not exist. (2 variants) [markuplint]
    related src/components/Menu.vue:8:24 referenced from aria-controls
```

Run-level errors (§8) are printed to stderr as they occur. A final summary line on stdout reports file and per-severity counts.

### 7.2 `--format ndjson`

**NDJSON** (newline-delimited JSON): one self-contained JSON value per line (`\n`-terminated, UTF-8, no pretty-printing), tagged by a `type` discriminant. This is the CLI's only machine-readable output — chosen over a single buffered document (the design's earlier `--format json` shape) so results can stream to stdout the same way `--format text` already does (§6 step 5), which matters for workspace-scale runs (hundreds of files) and for large runs piped straight into another process. Record shapes are normatively defined by these versioned types (also published as a JSON Schema next to the settings schema):

```ts
export type CliNdjsonRecord =
  | CliNdjsonMeta
  | CliNdjsonFile
  | CliNdjsonRunError
  | CliNdjsonSummary;

/** Always the first line of any run that reaches analysis. */
export interface CliNdjsonMeta {
  type: "meta";
  version: 1;
}

/** One per file, emitted as that file's analysis completes. */
export interface CliNdjsonFile {
  type: "file";
  /** Workspace-relative, "/"-separated. */
  path: string;
  diagnostics: readonly CliNdjsonDiagnostic[];
}

export interface CliNdjsonDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  origin: "core" | "validator" | "adapter";
  adapterId?: string;
  codeDescriptionHref?: string;
  range: { start: number; end: number }; // UTF-16 offsets into the SFC
  position: {
    startLine: number; startColumn: number; // 1-based; columns in UTF-16 units
    endLine: number; endColumn: number;
  };
  relatedInformation: readonly {
    path: string;
    range: { start: number; end: number };
    position: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    message: string;
  }[];
  evidence: { variantCount: number; truncated: boolean };
}

/** One per run-level error (§8), emitted as it occurs. */
export interface CliNdjsonRunError {
  type: "runError";
  /** e.g. "adapter/markuplint/configuration-error", "file-unreadable", "adapter-load/invalid-shape" */
  code: string;
  message: string;
  adapterId?: string;
  /** Workspace-relative, when the error is file-scoped. */
  path?: string;
}

/** Emitted once, last, only if the run reaches completion (§7.2 stdout validity). */
export interface CliNdjsonSummary {
  type: "summary";
  filesAnalyzed: number;
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  runErrors: number;
}
```

Contract:

- **Projection from `SourceDiagnostic`** (analyzer.md §3): `severity`, `code`, `message`, `origin`, `adapterId`, `codeDescriptionHref`, the primary range, and `relatedInformation` are carried over; `evidence` is projected to `variantCount` + `truncated` only. Everything else (`id`, variant IDs, example decisions, `generatedExample`) is internal and excluded. The output never contains generated HTML or source text.
- **Ordering:** `meta` is always the first line of any run that reaches analysis. `file` and `runError` lines are emitted in completion order, which under §6's current sequential, sorted-by-path processing is exactly path order — that guarantee holds only as long as file-level `analyze` stays sequential (§10's still-open file-level-parallelism question); a future move to parallel execution would need to either preserve it or explicitly relax it. `summary` is always the last line, present if and only if the run completed (see stdout validity below), and counts every severity so any `--fail-on` threshold can be recomputed without re-scanning every `file` line.
- **Compatibility:** adding an optional field to an existing record, or adding a new `type` value, is a minor change; consumers must ignore unknown fields and skip records whose `type` they don't recognize. Changing or removing a field, or changing a record's semantics, bumps `version` (carried on the `meta` line).
- **stdout validity:** lines are flushed as they are produced, not buffered — this is the point of choosing NDJSON. Stdout carries zero lines when the run fails before analysis starts (argument errors, fatal settings issues — §4.1); those cases report on stderr only. Once `meta` has been written, every subsequent line up to the point of interruption is a valid, independently parseable record. A signal (§6) stops the stream after whatever `file`/`runError` lines already completed — **no `summary` line is emitted**, which is exactly how a consumer detects an interrupted run: stream ended without a `summary` record. This differs deliberately from the old buffered contract ("exactly one document or nothing"): partial NDJSON output is valid and expected on interruption, not an error state. Whenever analysis ran, output is emitted **even on exit code 2**: run-level errors appear as `runError` lines, diagnostics already produced by other adapters and files are included as `file` lines, and (unless a signal also cut the run short) a `summary` line still closes the stream — failure isolation (monorepo.md §3) applies to the output, not just the process.

Example (a clean run — each line is independently valid JSON; the block as a whole is NDJSON, not one JSON document):

```text
{"type":"meta","version":1}
{"type":"file","path":"src/components/Toggle.vue","diagnostics":[{"severity":"error","code":"vue-html-bridge/non-finite-attribute-value","message":"...","origin":"validator","adapterId":"markuplint","range":{"start":116,"end":123},"position":{"startLine":6,"startColumn":19,"endLine":6,"endColumn":26},"relatedInformation":[],"evidence":{"variantCount":2,"truncated":false}}]}
{"type":"file","path":"src/components/Menu.vue","diagnostics":[]}
{"type":"summary","filesAnalyzed":2,"errors":1,"warnings":0,"infos":0,"hints":0,"runErrors":0}
```

## 8. Run outcomes and exit codes

The run outcome model distinguishes **diagnostics** (per-file analysis results, §7) from **run-level errors** — problems with the run itself. Run-level errors are reported once each, not once per file:

- a session-level adapter failure (`adapter/<id>/configuration-error`, `validator-unavailable`), keyed by adapter + code — the analyzer also places it as a source diagnostic per analyzed file, but the CLI reports it once at run level and does not repeat it per file;
- an adapter load failure from the shared loader, keyed by its dedupe key (adapter-loader.md);
- a file read error, keyed by path;
- an internal error.

After a run-level error, everything unaffected continues: other adapters keep validating, other files keep being analyzed, and every result already produced stays in the output (text and NDJSON alike). The error only determines the exit code.

| Exit code | Meaning |
| --- | --- |
| 0 | Analysis ran; no run-level error; no diagnostic at or above the `--fail-on` threshold |
| 1 | Analysis ran; no run-level error; at least one diagnostic at or above the threshold |
| 2 | A run-level error occurred (even if diagnostics were also produced), or the run failed before analysis: argument error, fatal settings issue (§4.1), explicit `--config` failure, or no analyzable input |
| 130 / 143 | Interrupted (SIGINT / SIGTERM) |

Precedence: signal code > 2 > 1 > 0. A misconfigured CI job must never pass as "no findings", which is why run-level errors dominate threshold results. `--fail-on never` reports everything but exits only 0, 2, or a signal code, for jobs that only collect output.

## 9. Tests

1. Flag → settings decomposition parity: a fixture table covering every settings field asserts that the flag layer produces the same `resolveSettings` output as the equivalent config file (shared fixtures with `@vue-html-bridge/settings`).
2. Precedence and fatality: flags > `--config` > discovered file > defaults; explicit `--config` missing/unreadable/unparsable exits 2 without fallback; error-level settings issues stop the run before analysis; warnings continue.
3. Validator flags: entry-key addressing (built-in id vs. package specifier, independent of any runtime `adapter.id`), application order, unknown entry key, dotted-path grammar (empty segments, dotted keys, array indices rejected), and prototype-pollution resistance: `__proto__` / `constructor` / `prototype` segments are rejected and `Object.prototype` is unchanged after any accepted flag.
4. File enumeration: positional args replace `include`; directory expansion; `exclude` applies; dotfile and `node_modules` behavior; symlink/duplicate arguments dedupe to one analysis; a path outside the workspace root is a run-level error; ordering is deterministic; no matches exits 2 with a clear message.
5. URI construction: `pathToFileURL`-based, stable per file within a run, correct on Windows paths and percent-encoded characters.
6. Text output golden, including related information, stderr run-level errors, and the summary line.
7. NDJSON goldens for three shapes: a clean run (`meta`, `file`×N, `summary`); an exit-2 run (`meta`, `file`/`runError` lines interleaved in completion order, `summary`); an interrupted run (`meta` plus zero or more `file`/`runError` lines, no `summary`). Every line parses independently with `JSON.parse`; `meta.version` present and first; unknown `type` values and unknown fields are tolerated by the golden-comparison harness itself (documented for external consumers); no generated HTML or source text embedded.
8. Offset → line/column conversion at the boundary: CRLF, emoji, zero-width ranges — the same fixture family as language-server §13.1, shared as fixtures.
9. Run outcome model: multi-file × multi-adapter fixture where one adapter's session fails — the failure appears once at run level, the other adapter's diagnostics and other files' results survive in the output, exit is 2. File read error behaves the same way.
10. Exit codes: `--fail-on` threshold interactions across all severities; run-level error dominance; `--fail-on never`.
11. Signals: SIGINT mid-analysis (abort, no partial rendering for the file being analyzed when the signal arrived; in NDJSON mode `meta` plus any already-completed `file`/`runError` lines remain on stdout with no trailing `summary` line; exit 130; sessions disposed); SIGTERM → 143; a second signal during cleanup exits immediately.
12. `--untrusted` combinations: trust-sensitive settings are forced (bundled Markuplint defaults, no external adapters) while shared safe settings (`include`/`exclude`, `warnVariantCount`, `maxConcurrency`, `customElements`, `customDirectives`, output flags) still apply from the same config; behavior matches the language server's restricted session on the same fixture.
13. External adapter loading: the shared loader's gates apply identically to the language server's (contract-tested against adapter-loader.md); a load failure disables only that adapter and is reported once.
14. E2E parity: on the language-server §13.3 fixture, both hosts are given the same trust policy, the same `resolveSettings` output (settings and issues compared), the same adapter loader results, and identical content (disk file == LSP buffer) — and report the same source diagnostics (code, range, severity, adapterId). A second, restricted-mode parity run asserts the same under `--untrusted` / an untrusted LSP workspace.

## 10. Open questions

Each item notes where the decision will be made.

- ~~Watch mode (`--watch`): overlaps with LSP debounce/cancellation machinery~~ — scoped out through Phase 3 (product decision, 2026-08-21); no current plan to build it, revisit if demand shows up (§1).
- ~~SARIF or other CI-native output formats, and NDJSON streaming for very large runs, on top of JSON v1~~ — NDJSON is the CLI's machine-readable output from the initial release, replacing the previously designed buffered `--format json` (product decision, 2026-08-21; §7.2). SARIF/other CI-native formats remain open — decide after initial-release feedback (ADR).
- ~~stdin input (`--stdin --stdin-filename <path>`) for editor-less integrations~~ — scoped out through Phase 3 (product decision, 2026-08-21); revisit if requested (§1).
- File-level parallel `analyze` on top of adapter-level concurrency (after the Phase 2 workspace-scale measurements: wall time, peak memory, NDJSON output size on representative repositories)
- ~~A persistent cross-run cache~~ — scoped out through Phase 3 (product decision, 2026-08-21); revisit based on real-world performance after initial use. analyzer.md §10.3 forbids writing generated HTML or source to disk, so if this is revisited it still needs its own design and privacy review (ADR; do not implement casually).

## 11. Proposed internal module layout

```text
src/
├── bin.ts            # entry point; signal handling; exit codes
├── cli.ts            # argument parsing; --help/--version; usage errors
├── options.ts        # flag ↔ settings-input mapping (the §4.2 table); dotted-path parsing
├── runner.ts         # enumeration, adapter loading (via adapter-loader), analyzer lifecycle, run outcome model
├── line-index.ts     # offset → line/column at the output boundary
├── output/
│   ├── text.ts
│   └── ndjson.ts      # CliNdjsonRecord line construction and streaming
└── exit-codes.ts
```

`options.ts` contains the only knowledge of the flag surface; `runner.ts` knows nothing about flags and takes a resolved settings object. Output modules take fully converted positions and never see the analyzer types beyond `SourceDiagnostic`.
