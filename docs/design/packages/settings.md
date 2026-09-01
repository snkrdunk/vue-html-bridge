# `@vue-html-bridge/settings` Design

Status: Implemented  
Package directory: `packages/settings`

## 1. Role

The single source of truth for the user-facing configuration: the settings schema (input and resolved forms), its defaults, layer resolution (validation + merging), decomposition into per-package options, loading of the shared workspace configuration files, and the published JSON schema.

Two hosts consume the same settings — the language server (via LSP `workspace/configuration` plus workspace files) and the CLI (via flags plus the same workspace files). Defining the schema and its semantics once is what guarantees the two hosts cannot drift. This package exists because the CLI was added; it resolves the former analyzer.md open question about splitting out a config loader for standalone analyzer consumers.

### In scope

- The input and resolved settings types, and the defaults table
- `resolveSettings`: validating an ordered stack of raw layers and merging them
- Decomposition into the options each package consumes
- Discovery and parsing of `.vue-html-bridge.json` / `package.json#vueHtmlBridge`, and loading an explicit settings file given by path
- Generating and publishing the JSON schema (`schema.json`)

### Out of scope

- LSP protocol types and `workspace/configuration` fetching (language server)
- Command-line flag parsing (CLI; its `options.ts` maps flags onto an input layer)
- Interpreting adapter-specific `validators[].settings` (opaque pass-through; validated where the Phase 1 decision placed it)
- Loading adapter packages (adapter-loader.md)
- Watching configuration files (each host owns its watcher/trigger)

## 2. Dependencies

None inside the monorepo at runtime. The decomposed option shapes (for example core's `GenerateOptions`) are declared structurally in this package, and their agreement with core/analyzer is pinned by contract tests — the same pattern core.md §7 and validator-api §2 use for shared structural types. This keeps the package importable by any future host without pulling in core.

## 3. Settings schema

This is the canonical definition. language-server.md §9.2 and cli.md §4 describe how each host layers values on top of it; they do not redefine the shape.

The input form and the resolved form are distinct types. Every layer — a JSON file, LSP `workspace/configuration`, CLI flags — provides the input form, where everything is optional. Consumers only ever see the resolved form.

```ts
/** What one configuration layer provides. All fields optional. */
export interface VueHtmlBridgeSettingsInput {
  enabled?: boolean;
  include?: readonly string[];
  exclude?: readonly string[];
  validateOnChange?: boolean;
  validateOnSave?: boolean;
  debounceMs?: number;
  maxConcurrency?: number;
  warnVariantCount?: number;
  customElements?: readonly string[];
  customDirectives?: readonly CustomDirectiveSettingInput[];
  externalAdapters?: "disabled" | "trusted-workspace-only";
  validators?: readonly ValidatorSettingInput[];
}

export interface ValidatorSettingInput {
  adapter: string;
  enabled?: boolean; // default: true
  settings?: unknown;
}

/** One entry of `customDirectives` (core.md §5.3.1, ADR-0010). */
export interface CustomDirectiveSettingInput {
  name: string;
  attributes: Record<string, string>; // attrName -> value template
}

/** The merged result every consumer receives. */
export interface ResolvedVueHtmlBridgeSettings {
  enabled: boolean;
  include: readonly string[];
  exclude: readonly string[];
  validateOnChange: boolean;
  validateOnSave: boolean;
  debounceMs: number;
  /** undefined = delegate to the analyzer's CPU-count-based default (monorepo.md §10.3). */
  maxConcurrency: number | undefined;
  /** undefined = delegate to core's default of 256 (core.md §2.1). */
  warnVariantCount: number | undefined;
  customElements: readonly string[];
  customDirectives: readonly ResolvedCustomDirectiveSetting[];
  externalAdapters: "disabled" | "trusted-workspace-only";
  validators: readonly ResolvedValidatorSetting[];
}

export interface ResolvedValidatorSetting {
  adapter: string;
  enabled: boolean;
  settings?: unknown;
}

export interface ResolvedCustomDirectiveSetting {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
}
```

Defaults where a package downstream owns the real value (`maxConcurrency`, `warnVariantCount`) are represented as `undefined` in the resolved form, not as a copied number or a `"auto"` sentinel: a JSON layer expresses "delegate" simply by omitting the field, and the resolved type makes the delegation visible to consumers instead of baking a second copy of another package's default into this one.

### 3.1 Defaults and constraints

| Field | Default | Constraints |
| --- | --- | --- |
| `enabled` | `true` | boolean |
| `include` | `["**/*.vue"]` | non-empty array of glob strings |
| `exclude` | `["**/node_modules/**"]` | array of glob strings |
| `validateOnChange` | `true` | boolean |
| `validateOnSave` | `true` | boolean |
| `debounceMs` | `200` | integer, `0`–`60000` |
| `maxConcurrency` | `undefined` (analyzer's CPU-count default) | integer, `>= 1` |
| `warnVariantCount` | `undefined` (core's default of 256) | integer, `>= 1` |
| `customElements` | `[]` | array of tag-name/glob strings |
| `customDirectives` | `[]` | see below |
| `externalAdapters` | `"disabled"` | enum |
| `validators` | `[{ adapter: "markuplint", enabled: true }]` | see below |

`validators[].adapter` is the entry key and is part of the public contract: the built-in adapter is addressed by its stable adapter **id** (`"markuplint"`, validator-api §3); an external adapter by its npm package specifier. The default enables the built-in Markuplint adapter by id. Two entries with the same `adapter` string in one layer are a `duplicate-adapter` error issue (the first entry wins). How the two identifier kinds are told apart and gated at load time is adapter-loader.md's contract.

`customDirectives[].name` must match `/^[A-Za-z][\w-]*$/` (`DirectiveNode.name`'s actual character set) and must not be one of the 15 reserved built-in/control directive names (`bind`, `on`, `model`, `text`, `html`, `slot`, `pre`, `if`, `else-if`, `else`, `for`, `show`, `once`, `memo`, `cloak`) — a `reserved-custom-directive` error, since such a mapping could never be reached by core's dispatch order. Two entries colliding on **camelized** name (`img-attr` and `imgAttr`) are a `duplicate-custom-directive` error; the first entry wins, matching `validators[]`'s precedent. `customDirectives[].attributes` must be a non-empty (after per-key filtering) object whose keys match `/^[a-zA-Z][\w:-]*$/` — an invalid key drops just that attribute entry, not the whole mapping, with an `invalid-type` issue; an attribute value template containing the literal text `"$value"` anywhere must fully match `/^\$value(?:\.[A-Za-z_$][\w$]*)*$/` (`$value` optionally followed by dotted property segments, e.g. `$value.src`) or it is rejected the same way; a template with **no** `$value` occurrence is a literal string constant, emitted verbatim (core.md §5.3.1, ADR-0010).

`enabled`, `validateOnChange`, `validateOnSave`, and `debounceMs` describe automatic editor-session behavior. They are part of the shared schema (a workspace file sets them once for both hosts), but a one-shot host ignores them; cli.md §4.2 documents that. Grouping these editor-only fields under a nested `editor: { ... }` section is a candidate for a future schema version; in v1 the schema stays flat.

`$schema` and `version` are reserved at the top level, so a schema version can be introduced later without a breaking change.

## 4. Resolution: validation + merging

Resolution is one normative operation, so the order of validation and merging cannot vary between hosts.

```ts
export interface SettingsIssue {
  severity: "warning" | "error";
  /** Machine-readable kind: "unknown-field" | "invalid-type" | "out-of-range" |
   *  "duplicate-adapter" | "file-missing" | "file-unreadable" | "parse-error" */
  code: string;
  path: string; // e.g. "validators[0].adapter"
  message: string;
  /** Absolute path of the settings file the layer came from, when applicable. */
  sourcePath?: string;
}

export function resolveSettings(
  layers: readonly unknown[], // lowest precedence first; raw, unvalidated
): {
  settings: ResolvedVueHtmlBridgeSettings;
  issues: readonly SettingsIssue[];
};
```

Semantics, in order:

1. **Each layer is validated independently first.** An unknown field is a `warning` issue and is dropped from that layer. A field with an invalid type or out-of-range value is an `error` issue, and that field is **pinned to its package default for the whole resolution** — an invalid value is not treated as absent, so a lower-precedence layer can never silently take effect in its place. This is deliberately fail-closed: for a trust-sensitive field like `externalAdapters`, garbage in a higher layer resolves to the safe default (`"disabled"`), never to a lower layer's `"trusted-workspace-only"`.
2. **Validated layers are then merged**, lowest precedence first: objects field by field, arrays fully replaced by the higher-precedence layer. There is no array concatenation.
3. Resolution is pure and deterministic. What to do with issues is the host's decision, and the two hosts intentionally differ:
   - The **language server** continues with the resolved settings and reports the issues once per workspace — an invalid settings file degrades analysis, it never turns the editor dark (language-server.md §9.2).
   - The **CLI** treats `error` issues as fatal: it prints them to stderr and exits with code 2 before analyzing anything — CI must fail loudly on misconfiguration. `warning` issues go to stderr and the run continues (cli.md §8).

The CLI/LSP parity tests compare both outputs of `resolveSettings` — the resolved settings and the issue list — for the same layer stack, so the shared semantics are pinned, not assumed.

## 5. Settings files

```ts
export interface SettingsFileResult {
  settings: VueHtmlBridgeSettingsInput;
  issues: readonly SettingsIssue[];
  /** Absolute path of the file the settings came from, for watching and messages. */
  sourcePath?: string;
}

/** Discovery inside one workspace root. */
export function loadWorkspaceSettingsFile(
  workspaceRoot: string,
  fileSystem: SettingsFileSystem, // injected for testability
): Promise<SettingsFileResult>;

/** An explicit settings file given by path (e.g. the CLI's --config). */
export function loadSettingsFile(
  filePath: string, // absolute; the host resolves relative input (the CLI resolves from cwd) before calling
  fileSystem: SettingsFileSystem,
): Promise<SettingsFileResult>;
```

- Discovery order inside one workspace root: `.vue-html-bridge.json`, then the `vueHtmlBridge` field of `package.json`. The first hit wins; they are not merged with each other.
- An explicit file loaded by `loadSettingsFile` must contain the settings object itself — the same shape as `.vue-html-bridge.json`. A `package.json` passed here is not special-cased; the `vueHtmlBridge` extraction exists only in workspace discovery.
- Failure kinds are distinguished as issue codes, all with `sourcePath` set: `file-missing`, `file-unreadable`, `parse-error`. The loaders never throw for content problems. Whether a failure is fatal is the host's decision: for discovery, a missing file is not an issue at all (defaults apply); for an explicit file, the CLI treats every one of these as fatal (cli.md §4.1), and the language server may keep a previous known-good state (language-server.md §9.3).
- Any relative path inside settings values (for example an adapter's `configFile`) resolves against the **workspace root**, never against the settings file's own location. Adapter settings are opaque here; this rule is the documented convention adapters follow (adapter-markuplint.md §2).
- The loaders read only the given root/path. They never walk upward past the workspace root and never execute code — the shared bridge settings are JSON-only by design.

## 6. Decomposition

```ts
export interface DecomposedSettings {
  generateOptions: GenerateOptions; // structural; contract-tested against core
  analyzer: { maxConcurrency?: number };
  validators: readonly ResolvedValidatorSetting[];
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
  settings: ResolvedVueHtmlBridgeSettings,
): DecomposedSettings;
```

A delegated field (`maxConcurrency`, `warnVariantCount` = `undefined`) is omitted from the decomposed options, so the downstream package's own default applies — this package never copies another package's default value.

| Settings field | Consumed by |
| --- | --- |
| `warnVariantCount`, `customElements`, `customDirectives` | core's `GenerateOptions` (through the analyzer's `generateOptions`) |
| `maxConcurrency` | analyzer's `CreateWorkspaceAnalyzerOptions` / `ReconfigureOptions` |
| `validators` | adapter loading (adapter-loader.md), then each adapter's `AdapterSessionContext.settings` |
| `enabled`, `include`/`exclude`, `validateOn*`, `debounceMs`, `externalAdapters` | the host (language server or CLI) |

## 7. JSON schema

`schema.json` is generated from this package's definition (the input form, since that is what users write), pinned by a golden test, and **published as this package's own export**:

```jsonc
// package.json (excerpt)
{
  "exports": {
    ".": "./dist/index.js",
    "./schema.json": "./schema.json"
  }
}
```

The canonical `$schema` reference is `./node_modules/@vue-html-bridge/settings/schema.json`. It must resolve in any installation that can run the bridge — including a CLI-only project that does not depend on the language server. The language-server package ships a copy as a backward-compatibility alias for existing `$schema` references; that copy is produced at build time from this package, never edited by hand.

Where a §3.1 rule is expressible as a JSON-schema `pattern`, the generated schema carries it as an editor-level hint built from resolve.ts's real constants (never a hand-written second copy): `customDirectives[].attributes` constrains its keys via `propertyNames` (the attribute-name pattern) and each value via a pattern accepting either a `$value`-free literal constant or the `$value` dotted-path grammar. `resolveSettings` remains the authoritative validation — the schema only lets an editor flag these mistakes before a run.

## 8. Tests

1. Defaults: `resolveSettings([])` equals the §3.1 table, including the delegated `undefined` values and the default `validators` entry.
2. Merge matrix: field-by-field object merge, full array replacement, layer precedence order.
3. Validation: unknown field → warning + dropped; invalid type / out-of-range per field → error + pinned to default; `$schema`/`version` accepted and ignored; `duplicate-adapter` detection. `customDirectives[]`: per-item validation (one bad entry dropped without discarding the rest); exact-name and camelized-name duplicate detection (`duplicate-custom-directive`); reserved-name rejection (`reserved-custom-directive`); `$value`-grammar accept/reject cases; attribute-key pattern rejection (a key with a space or quote drops just that attribute).
4. Pinning beats lower layers: an invalid `externalAdapters` in the top layer resolves to `"disabled"` even when a lower layer validly sets `"trusted-workspace-only"`, with an `error` issue.
5. Discovery loader: order, first-hit-wins, parse error → issue with `sourcePath`, no upward traversal.
6. Explicit-file loader: settings-object-only format (no `package.json` extraction), `file-missing` / `file-unreadable` / `parse-error` distinguished, absolute `sourcePath`.
7. Decomposition table parity: a shared fixture asserts the §6 table, including that delegated fields are omitted and that `customDirectives` (like `customElements`) is an always-present passthrough, never omitted; the same fixture is reused by the language-server and CLI test suites so a new field cannot be routed inconsistently.
8. Contract tests: the structural `GenerateOptions` shape accepted by core, and the analyzer options shape, match this package's declarations. This package's intentionally-duplicated `customDirectives` validation constants (`ATTRIBUTE_NAME_PATTERN` / `VALUE_PATH_PATTERN` regex sources, and the reserved-directive-name set) are pinned against core's own exports of the same constants, so the two copies can never drift apart silently.
9. `schema.json` golden: regeneration is byte-identical; a schema change requires an intentional golden update. The export path `@vue-html-bridge/settings/schema.json` resolves from a consumer package.

## 9. Proposed internal module layout

```text
src/
├── index.ts
├── schema.ts       # input/resolved types + reserved fields
├── defaults.ts     # the §3.1 table
├── resolve.ts      # per-layer validation + merge (the §4 semantics)
├── decompose.ts
├── loader.ts       # workspace discovery + explicit file (fs injected)
└── json-schema.ts  # schema.json generation
```
