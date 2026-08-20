# `@vue-html-bridge/adapter-loader` Design

Status: Proposed  
Package directory: `packages/adapter-loader`

## 1. Role

The host-neutral, single implementation of validator-adapter loading and trust gating, shared by the language server and the CLI.

Which adapters get loaded, under which trust conditions, and how load failures are classified is security-sensitive behavior. If each host implemented it separately, the two would inevitably drift — and a drift here is not a cosmetic difference but a difference in what workspace code gets executed. This package owns that logic once; hosts only render the structured results.

### In scope

- Turning resolved `validators[]` entries into ready-to-use adapter instances
- Injecting built-in adapters (addressed by adapter id)
- The external-adapter gates: explicit configuration, `externalAdapters` mode, workspace trust, package-specifier validation, workspace module resolution, runtime shape and `apiVersion` checks
- Structured, deduplicated `AdapterLoadFailure` results
- Deterministic ordering of both adapters and failures

### Out of scope

- Session creation, caching, lifecycle (analyzer)
- Settings schema and resolution (settings)
- Rendering failures to users: LSP notifications (language server) and stderr / run-level errors (CLI)
- Sandboxing loaded code — loading remains a trust boundary, not a security boundary (language-server.md §10.2)

## 2. Dependencies

```text
adapter-loader ──> @vue-html-bridge/validator-api   # adapter types + runtime-check
```

Nothing else inside the monorepo. The `ResolvedValidatorSetting` input shape is declared structurally and pinned to `@vue-html-bridge/settings` by a contract test — the same pattern the other structural cross-package types use.

## 3. Public API

```ts
export interface LoadAdaptersRequest {
  validators: readonly ResolvedValidatorSetting[]; // structural; from settings.md §3
  workspaceRoot: string;
  trust: {
    workspaceTrusted: boolean;
    externalAdapters: "disabled" | "trusted-workspace-only";
  };
  /** Built-in adapters, keyed by adapter id (e.g. "markuplint"). Hosts inject their bundled adapters here. */
  builtins: ReadonlyMap<string, HtmlValidatorAdapter<unknown>>;
  /** Module resolution/import, injected for tests and future PnP support. Defaults to workspace Node resolution. */
  moduleResolver?: AdapterModuleResolver;
  logger?: AdapterLogger;
}

export interface LoadAdaptersResult {
  /** Loaded, runtime-validated adapters paired with their settings — ready for createWorkspaceAnalyzer. */
  adapters: readonly LoadedAdapter[];
  /** Structured failures, deduplicated and deterministically ordered. */
  failures: readonly AdapterLoadFailure[];
}

export interface LoadedAdapter {
  adapter: HtmlValidatorAdapter<unknown>;
  settings: unknown;
  enabled: boolean;
  /** The validators[].adapter string this instance came from. */
  entryKey: string;
}

export interface AdapterLoadFailure {
  /** The validators[].adapter string. */
  specifier: string;
  kind:
    | "external-adapters-disabled" // externalAdapters !== "trusted-workspace-only"
    | "workspace-not-trusted"
    | "invalid-specifier"          // not a plain npm package specifier
    | "resolution-failed"
    | "import-threw"
    | "invalid-shape"              // fails validator-api runtime-check
    | "api-version-mismatch"
    | "duplicate-runtime-id";      // two loaded adapters expose the same adapter.id
  message: string;
  /** Stable key for host-side notice deduplication: specifier + kind. */
  dedupeKey: string;
}

export async function loadConfiguredAdapters(
  request: LoadAdaptersRequest,
): Promise<LoadAdaptersResult>;
```

## 4. Loading rules

For each `validators[]` entry, in order:

1. **Built-in:** if the entry key matches a key in `builtins`, that instance is used directly. Built-ins bypass the external gates — they are the host's own dependencies — but not the runtime `apiVersion` assertion.
2. **External:** otherwise the entry key is treated as a package specifier and must pass every gate, matching language-server.md §10.2:
   - the entry is explicit in settings (being here means it is),
   - `trust.externalAdapters === "trusted-workspace-only"`,
   - `trust.workspaceTrusted === true`,
   - the specifier is a plain npm package name — no paths, URLs, or data URIs,
   - it resolves through the workspace's module resolution (the loader never searches arbitrary paths),
   - the imported export passes validator-api's `runtime-check` and has `apiVersion === 1`.
3. Every failure is isolated to its entry: one bad adapter never prevents loading the others.
4. After loading, runtime `adapter.id` values must be unique across the result; a collision is a `duplicate-runtime-id` failure for the later entry (deterministic: entry order decides which one is kept).
5. `adapters` and `failures` are deterministically ordered by entry order; failures are deduplicated by `dedupeKey`.

Disabled entries (`enabled: false`) are returned in `adapters` with `enabled: false` and are not imported at all — a disabled external adapter must not execute code.

## 5. Host responsibilities

The hosts keep only presentation and retry policy:

- The **language server** converts failures to per-workspace notices deduplicated by `dedupeKey`, retries on `workspace/didChangeConfiguration`, and passes `workspaceTrusted` from its initialization options (language-server.md §10.2).
- The **CLI** converts failures to stderr messages and run-level errors (exit code 2 semantics; cli.md §8), and derives `workspaceTrusted` from its invocation-trusted default and `--untrusted` (cli.md §5).

The analyzer is unchanged: it continues to accept only already-loaded, runtime-validated adapter instances (analyzer.md §2).

## 6. Tests

1. Gate matrix: each of `external-adapters-disabled`, `workspace-not-trusted`, `invalid-specifier`, `resolution-failed`, `import-threw`, `invalid-shape`, `api-version-mismatch` produced by exactly the matching condition, with the other entries still loading.
2. Built-in injection: entry key matching a builtin id loads without touching the module resolver; a builtin with a mismatched `apiVersion` still fails.
3. Specifier validation: paths, relative specifiers, URLs, and data URIs are rejected without any resolution attempt.
4. `duplicate-runtime-id`: deterministic keep-first behavior and a failure for the later entry.
5. Disabled entries are never imported (the module resolver records no call).
6. Determinism: same request → same adapter order, failure order, and dedupe keys.
7. Contract test pinning the structural `ResolvedValidatorSetting` shape to `@vue-html-bridge/settings`.
8. Both hosts run a shared contract fixture against their integration, so LS and CLI observably apply identical gating (referenced from language-server §13.1 and cli.md §9).

## 7. Proposed internal module layout

```text
src/
├── index.ts
├── load.ts          # loadConfiguredAdapters orchestration
├── gates.ts         # trust / specifier / apiVersion checks
├── resolver.ts      # default workspace module resolution (injectable)
└── failures.ts      # failure construction, dedupe keys, ordering
```
