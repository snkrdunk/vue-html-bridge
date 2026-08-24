# `@vue-html-bridge/validator-api` Design

Status: Implemented
Package directory: `packages/validator-api`

## 1. Role

Provides a validator-independent Service Provider Interface (SPI) that connects any HTML validator to vue-html-bridge.

This package has no implementation of its own. It is a small runtime/type package. Its public API does not include Markuplint-specific types, LSP types, or the Vue compiler AST.

### In scope

- Types for adapter / session / validate request / result
- Normalized diagnostic/failure types on generated HTML
- Capability, logger, and configuration context
- The `apiVersion` compatibility contract
- Handling of `AbortError` and adapter failures

### Out of scope

- Adapter discovery and loading
- Session cache/lifecycle management
- SFC mapping and source diagnostics
- Running validators
- LSP conversion

## 2. Dependencies

Does not depend on any production package inside the monorepo. This lets adapter authors use the SPI and the contract tests without installing core.

`GeneratedRange` is defined in this package as a small structural type. Its meaning matches the same-named type in core through a shared coordinate contract, but validator-api does not depend on core just to share the type. The analyzer connects both sides.

## 3. Public SPI

```ts
export const VALIDATOR_API_VERSION = 1 as const;

export interface GeneratedRange {
  /** UTF-16 code unit offset into request.html. Inclusive. */
  start: number;
  /** UTF-16 code unit offset into request.html. Exclusive. */
  end: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface HtmlValidatorAdapter<TSettings = unknown> {
  readonly apiVersion: typeof VALIDATOR_API_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;

  createSession(
    context: AdapterSessionContext<TSettings>,
  ): Promise<ValidatorSession>;
}

export interface AdapterCapabilities {
  execution: "in-process" | "subprocess" | "remote";
  supportsCancellation: boolean;
  supportsConfigFiles: boolean;
  /** Whether the adapter handles a fragment directly, or wraps it in a document internally. */
  fragmentHandling: "native" | "wrapped";
  /**
   * Maximum number of concurrent validate calls for one session. 1 = serial only.
   * The host must respect both this limit and the global concurrency limit.
   */
  maxConcurrentValidations: number;
  /**
   * For adapters with supportsConfigFiles: true, the globs for known
   * configuration file candidates to watch. These patterns detect files
   * that do not exist yet and newly-created nearer configs. Concrete files
   * already resolved by a session are reported by getConfigWatchTargets().
   */
  configFilePatterns?: readonly string[];
}
```

`id` is a stable identifier, independent of the npm package name. Example: `markuplint`, `vnu`. It is used for the LSP diagnostic `source`, the cache key, and settings identification.

### 3.1 Session

```ts
export interface AdapterSessionContext<TSettings = unknown> {
  workspaceRoot: string;
  settings: TSettings;
  logger: AdapterLogger;
}

export interface ConfigWatchTarget {
  /** Normalized absolute path of a local file. Globs and URIs are not accepted. */
  absolutePath: string;
  /** Why the validator depends on this file. */
  kind: "config" | "dependency";
}

export interface ValidatorSession {
  validate(
    request: ValidateHtmlRequest,
    signal: AbortSignal,
  ): Promise<ValidateHtmlResult>;

  /**
   * Returns the current snapshot of concrete local files whose changes
   * require this session to be recreated. The snapshot may grow after
   * validate() discovers another source-local config or dependency.
   */
  getConfigWatchTargets?(): readonly ConfigWatchTarget[];

  dispose(): Promise<void>;
}
```

Create one session per combination of workspace and adapter settings. This lets expensive resources — configuration, engine, subprocess, connection, and so on — be reused. `dispose` must be safe to call more than once, and `validate` after disposal must either return an explicit failure or reject.

`configFilePatterns` and `getConfigWatchTargets` have complementary roles. Candidate patterns let the host observe creation of a config that was not previously resolved. Concrete targets cover an explicit config, the config selected for a validated source file, arbitrarily named `extends` targets, and plugin files when the adapter can resolve them. A returned snapshot is sorted and deduplicated by `absolutePath`, is deterministic for the same session state, and contains no source or generated HTML. If the same path is both a config and a dependency, the single retained entry uses `kind: "config"`. An adapter that uses local configuration files must implement this method; an adapter whose configuration is entirely remote or in-memory may omit it.

**createSession failure contract:** Environmental failures, such as failing to load configuration or failing to start the validator, must reject with an error that has this runtime shape.

```ts
export interface AdapterSessionFailure extends Error {
  name: "AdapterSessionFailure";
  failure: AdapterFailure; // configuration-error | validator-unavailable, etc.
}
```

If `failure.recoverable` is true, the host can retry session creation after the settings change. A rejection without this shape is treated as an adapter programming error, and the host isolates it as the equivalent of `execution-error`. When session creation fails, existing host-side sessions — for other adapters or older settings — are not affected.

### 3.2 Validate request

```ts
export interface ValidateHtmlRequest {
  /** Static HTML fragment with no Vue directives. */
  html: string;

  /** Always "fragment" in v1. Stated explicitly for future compatibility. */
  documentKind: "fragment";

  /** Absolute path of the original SFC. Used for configuration discovery and display. */
  sourceFilename: string;

  /** Unique virtual path that lets the validator recognize this as HTML. */
  virtualFilename: string;
}
```

`virtualFilename` follows this format. This format is a public contract of the SPI. Do not change it in a breaking way, because user settings — for example, a Markuplint config's overrides glob — depend on it. Keeping this format correct is the responsibility of the caller that builds the request (the analyzer, adapter-testkit, or a direct consumer).

```text
/workspace/src/Component.vue.__vue_html_bridge__/variant-<content-hash>.html
```

The final segment is derived deterministically from the content hash of `html`, not from the variant ID. The same HTML is always validated under the same virtual filename. So even when path-dependent config exists — such as overrides or excludeFiles — reusing a validation result for the same HTML is deterministic and does not depend on which variant was chosen as the representative one.

The adapter uses `sourceFilename` as the starting point for configuration discovery, and `virtualFilename` to decide the parser or input kind. If a validator accepts only one filename, the adapter's own documentation defines the override semantics.

The input to the SPI is always a fragment. An adapter for a validator that accepts only a full document should set `fragmentHandling: "wrapped"`, and may add a wrapper such as `<!doctype html><html>...</html>` internally. However, it must not return diagnostics that come only from the wrapper as `GeneratedDiagnostic`, and it is responsible for converting ranges back to `request.html` coordinates by subtracting the wrapper prefix length from the range inside the fragment.

### 3.3 Result

```ts
export interface ValidateHtmlResult {
  diagnostics: readonly GeneratedDiagnostic[];
  failures: readonly AdapterFailure[];
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface GeneratedDiagnostic {
  ruleId?: string;
  severity: DiagnosticSeverity;
  message: string;
  range?: GeneratedRange;
  applicability?: DiagnosticApplicability;
  codeDescriptionHref?: string;
  fingerprint?: string;
  data?: Readonly<Record<string, JsonValue>>;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type DiagnosticApplicability =
  /** Checks the meaning or conformance of the rendered HTML fragment itself. Default. */
  | "html-semantics"
  /** A policy about the input representation itself, such as quoting, style, or inline syntax. */
  | "source-representation"
  /** Cannot be determined without a document root or a host outside the fragment. */
  | "document-context";

export interface AdapterFailure {
  code:
    | "configuration-error"
    | "validator-unavailable"
    | "execution-error"
    | "invalid-validator-result";
  message: string;
  recoverable: boolean;
  details?: Readonly<Record<string, JsonValue>>;
}
```

`GeneratedDiagnostic.range` is a UTF-16 `[start, end)` range into `html`. If the validator does not return a position, use `undefined`. Do not invent a guessed value.

The default value of `applicability` is `html-semantics`. The adapter classifies a rule from its meaning alone, and does not guess at Vue provenance. The analyzer combines this classification with core's provenance data, so the bridge can safely suppress diagnostics that apply only to source representations it synthesized. A rule that cannot be classified stays `html-semantics`, to avoid false negatives.

`adapterId` and `variantId` can be attached by the analyzer from the session/request context, so individual diagnostics do not need to carry them redundantly.

### 3.4 Logger

```ts
export interface AdapterLogger {
  debug(message: string, data?: Readonly<Record<string, JsonValue>>): void;
  info(message: string, data?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, data?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, data?: Readonly<Record<string, JsonValue>>): void;
}
```

Do not log the full source text, the full HTML text, environment variables, or secrets inside settings. Adapters must not use the console directly; they must use the logger they are given.

## 4. Error and cancellation contract

- An interruption via `AbortSignal` must reject with `AbortError`. Do not convert it into a normal diagnostic or failure.
- An environmental failure in `createSession` must reject with `AdapterSessionFailure` (§3.1). Do not defer it until `validate`.
- If the validator finds an HTML violation, put it in `diagnostics`; do not reject.
- Put a config parse error, a missing binary, a validator crash, or a response parse error into `failures`.
- An adapter's own programming error may reject. The analyzer catches this at the adapter boundary and isolates it as the equivalent of `execution-error`.
- Even for an adapter with `supportsCancellation: false`, the analyzer may discard the result. The adapter should check the signal before starting and after finishing.
- An API that streams partial diagnostics is not included in v1.

## 5. Determinism

For the same HTML, source filename, settings, and validator version, the meaning and order of diagnostics must be deterministic.

Before returning, the adapter sorts diagnostics in this order:

1. `range.start` (no range sorts last)
2. `range.end`
3. severity
4. `ruleId`
5. message

`metadata` and `data` must contain only JSON-serializable values. Do not expose a validator's class instances, AST nodes, or Error objects directly.

## 6. Severity and fingerprint

The adapter maps validator-specific severity to the common values, preserving it as closely as possible. If the validator has no severity, default to `error`, and document that choice in the adapter's own documentation.

`fingerprint` is optional. It lets the analyzer safely aggregate diagnostics that share the same cause but differ in value or supplementary text between variants. Build it deterministically from the validator rule and semantic parameters, without including the source range. If the adapter cannot provide one, the analyzer falls back to `ruleId + normalized message`.

## 7. Example adapter implementation

```ts
export const exampleAdapter: HtmlValidatorAdapter<ExampleSettings> = {
  apiVersion: 1,
  id: "example",
  displayName: "Example HTML Validator",
  capabilities: {
    execution: "in-process",
    supportsCancellation: true,
    supportsConfigFiles: false,
    fragmentHandling: "native",
    maxConcurrentValidations: 4,
  },

  async createSession({ settings, logger }) {
    const engine = createExampleEngine(settings);

    return {
      async validate(request, signal) {
        signal.throwIfAborted();
        try {
          const raw = await engine.check(request.html, signal);
          return {
            diagnostics: raw.issues.map((issue) => ({
              ruleId: issue.rule,
              severity: issue.warning ? "warning" : "error",
              message: issue.message,
              range: toUtf16Range(request.html, issue.location),
              applicability: classifyApplicability(issue.rule),
            })),
            failures: [],
          };
        } catch (error) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          logger.error("Validator execution failed");
          return {
            diagnostics: [],
            failures: [
              {
                code: "execution-error",
                message: toSafeMessage(error),
                recoverable: true,
              },
            ],
          };
        }
      },
      async dispose() {
        await engine.close();
      },
    };
  },
};
```

## 8. Versioning

- Check v1 runtime compatibility with `apiVersion === 1`.
- Adding an optional field is a minor change; changing a required field or its meaning is a major change.
- An adapter's peer dependency declares the matching `@vue-html-bridge/validator-api` major range.
- When a new `apiVersion` major is added, plan a transition period where the language server/analyzer can handle both the old and new versions at once.
- Do not rely on TypeScript structural typing alone; perform minimal runtime validation at load time.

## 9. Test requirements

Every adapter must pass the contract suite in `@vue-html-bridge/adapter-testkit`.

- Valid HTML returns no diagnostics.
- The range for invalid HTML matches the UTF-16 offset.
- Validator coordinates are converted correctly for emoji and multi-line HTML.
- A diagnostic without a position is returned with `range: undefined`, unchanged.
- Severity/rule/message are stable.
- Cancellation and dispose behave as the contract requires.
- Config/execution failures are not mixed in with HTML diagnostics.
- An environmental failure in `createSession` rejects with the `AdapterSessionFailure` shape.
- Concurrent validate calls within `maxConcurrentValidations` produce a result that matches serial execution.
- An adapter with `fragmentHandling: "wrapped"` excludes wrapper-only diagnostics and corrects ranges back to `request.html` coordinates.
- Does not change the `html` field or the `request` object.
- The result order for the same input is deterministic.
- `result`/`data` are JSON-serializable.
- If the adapter uses local configuration files, `getConfigWatchTargets()` returns sorted, deduplicated absolute paths and includes concrete config/dependency files discovered during validation.

## 10. Proposed internal module layout

```text
src/
├── index.ts          # public exports only
├── adapter.ts        # adapter/session/capability types
├── diagnostics.ts    # range/severity/applicability/result/failure types
├── logger.ts
└── runtime-check.ts  # minimal runtime validation of an external adapter export
```

runtime-check does not resolve package names or perform dynamic imports. It only checks whether the unknown export it is given has the v1 adapter shape. If `getConfigWatchTargets` is present on a session, the host also validates the returned snapshot before registering filesystem watchers.
