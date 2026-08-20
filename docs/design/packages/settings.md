# `@vue-html-bridge/settings` Design

Status: Proposed  
Package directory: `packages/settings`

## 1. Role

The single source of truth for the user-facing configuration: the flat `VueHtmlBridgeSettings` schema, its defaults, layer merging, runtime validation, decomposition into per-package options, and loading of the shared workspace configuration files.

Two hosts consume the same settings — the language server (via LSP `workspace/configuration` plus workspace files) and the CLI (via flags plus the same workspace files). Defining the schema and its semantics once is what guarantees the two hosts cannot drift. This package exists because the CLI was added; it resolves the former analyzer.md open question about splitting out a config loader for standalone analyzer consumers.

### In scope

- The `VueHtmlBridgeSettings` / `ValidatorSetting` types and default values
- Merging an ordered stack of settings layers (host layer on top)
- Runtime validation: unknown-field warnings, invalid-type fallbacks
- Decomposition into the options each package consumes
- Discovery and parsing of `.vue-html-bridge.json` / `package.json#vueHtmlBridge`
- Generating the published JSON schema (`schema.json`)

### Out of scope

- LSP protocol types and `workspace/configuration` fetching (language server)
- Command-line flag parsing (CLI; its `options.ts` maps flags onto a settings layer)
- Interpreting adapter-specific `validators[].settings` (opaque pass-through; validated where the Phase 1 decision placed it)
- Watching configuration files (each host owns its watcher/trigger)

## 2. Dependencies

None inside the monorepo at runtime. The decomposed option shapes (for example core's `GenerateOptions`) are declared structurally in this package, and their agreement with core/analyzer is pinned by contract tests — the same pattern core.md §7 and validator-api §2 use for shared structural types. This keeps the package importable by any future host without pulling in core.

## 3. Settings schema

This is the canonical definition. language-server.md §9.2 and cli.md §4 describe how each host layers values on top of it; they do not redefine the shape.

```ts
export interface VueHtmlBridgeSettings {
  enabled: boolean;
  include: readonly string[]; // default: ["**/*.vue"]
  exclude: readonly string[];
  validateOnChange: boolean; // default: true
  validateOnSave: boolean; // default: true
  debounceMs: number; // default: 200
  maxConcurrency: number; // if not set, uses the analyzer default (based on CPU count; monorepo.md §10.3)
  warnVariantCount: number; // if not set, uses the core default of 256 (core.md §2.1)
  customElements: readonly string[]; // default: []. Passed to core's GenerateOptions.customElements
  externalAdapters: "disabled" | "trusted-workspace-only";
  validators: readonly ValidatorSetting[];
}

export interface ValidatorSetting {
  adapter: string;
  enabled: boolean;
  settings?: unknown;
}
```

`$schema` and `version` are reserved at the top level, so a schema version can be introduced later without a breaking change.

`enabled`, `validateOnChange`, `validateOnSave`, and `debounceMs` describe automatic editor-session behavior. They are part of the shared schema (a workspace file sets them once for both hosts), but a one-shot host ignores them; cli.md §4.2 documents that.

## 4. Merging and validation

```ts
export const defaultSettings: VueHtmlBridgeSettings;

export interface SettingsIssue {
  severity: "warning" | "error";
  path: string; // e.g. "validators[0].adapter"
  message: string;
}

export function validateSettings(input: unknown): {
  settings: Partial<VueHtmlBridgeSettings>;
  issues: readonly SettingsIssue[];
};

export function mergeSettings(
  layers: readonly Partial<VueHtmlBridgeSettings>[], // lowest precedence first
): VueHtmlBridgeSettings;
```

- Objects are merged field by field; arrays are fully replaced by the higher-precedence layer. There is no array concatenation.
- An unknown field produces a `warning` issue and is dropped.
- An invalid type produces an `error` issue, and the field falls back to the known safe default — a broken settings file degrades analysis; it never crashes the host.
- Merging is pure and deterministic; hosts decide what to do with issues (the language server logs and reports per workspace, the CLI prints to stderr and factors errors into its exit code).

The host supplies its own top layer: the language server passes the `vueHtmlBridge` section from `workspace/configuration`; the CLI passes the layer built from flags. Layers below that are the same for both hosts (§5, then defaults).

## 5. Workspace configuration files

```ts
export interface SettingsFileResult {
  settings: Partial<VueHtmlBridgeSettings>;
  issues: readonly SettingsIssue[];
  /** Absolute path of the file the settings came from, for watching and messages. */
  sourcePath?: string;
}

export function loadWorkspaceSettingsFile(
  workspaceRoot: string,
  fileSystem: SettingsFileSystem, // injected for testability
): Promise<SettingsFileResult>;
```

- Discovery order inside one workspace root: `.vue-html-bridge.json`, then the `vueHtmlBridge` field of `package.json`. The first hit wins; they are not merged with each other.
- A parse error is returned as an `error` issue with the file path; the loader never throws for content problems. Hosts decide whether to keep a previous known-good state (language-server.md §9.3) or fail the run (cli.md §8).
- The loader reads only these known filenames inside the given root. It never walks upward past the workspace root and never executes code — the shared bridge settings are JSON-only by design.

## 6. Decomposition

```ts
export interface DecomposedSettings {
  generateOptions: GenerateOptions; // structural; contract-tested against core
  analyzer: { maxConcurrency?: number };
  validators: readonly ValidatorSetting[];
  host: {
    enabled: boolean;
    include: readonly string[];
    exclude: readonly string[];
    validateOnChange: boolean;
    validateOnSave: boolean;
    debounceMs: number;
    externalAdapters: "disabled" | "trusted-workspace-only";
  };
}

export function decomposeSettings(
  settings: VueHtmlBridgeSettings,
): DecomposedSettings;
```

| Settings field | Consumed by |
| --- | --- |
| `warnVariantCount`, `customElements` | core's `GenerateOptions` (through the analyzer's `generateOptions`) |
| `maxConcurrency` | analyzer's `CreateWorkspaceAnalyzerOptions` / `ReconfigureOptions` |
| `validators[].settings` | each adapter's `AdapterSessionContext.settings` |
| `enabled`, `include`/`exclude`, `validateOn*`, `debounceMs`, `externalAdapters` | the host (language server or CLI) |

## 7. JSON schema

`schema.json` is generated from this package's definition and pinned by a golden test. The language-server package continues to ship a copy so existing `$schema` references (`./node_modules/@vue-html-bridge/language-server/schema.json`) keep working; the copy is produced at build time from this package, never edited by hand.

## 8. Tests

1. Defaults: `mergeSettings([])` equals `defaultSettings`, and every documented default value matches.
2. Merge matrix: field-by-field object merge, full array replacement, layer precedence order.
3. Validation: unknown field → warning + dropped; invalid type per field → error + safe default; `$schema`/`version` accepted and ignored.
4. Loader: discovery order, first-hit-wins, parse error → issue with `sourcePath`, no upward traversal.
5. Decomposition table parity: a shared fixture asserts the §6 table; the same fixture is reused by the language-server and CLI test suites so a new field cannot be routed inconsistently.
6. Contract tests: the structural `GenerateOptions` shape accepted by core, and the analyzer options shape, match this package's declarations.
7. `schema.json` golden: regeneration is byte-identical; a schema change requires an intentional golden update.

## 9. Proposed internal module layout

```text
src/
├── index.ts
├── schema.ts       # types + reserved fields
├── defaults.ts
├── validate.ts
├── merge.ts
├── decompose.ts
├── loader.ts       # workspace file discovery/parsing (fs injected)
└── json-schema.ts  # schema.json generation
```
