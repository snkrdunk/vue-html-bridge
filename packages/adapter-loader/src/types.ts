/**
 * Public API types (adapter-loader.md §3).
 */
import type {
  AdapterLogger,
  HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";

/**
 * One entry of the resolved `validators` list, as `loadConfiguredAdapters`
 * consumes it. Declared structurally rather than imported at runtime
 * (adapter-loader.md §2: "Nothing else inside the monorepo") and pinned to
 * the real `@vue-html-bridge/settings` shape by a contract test
 * (`contract.test.ts`) — the same devDependency-only pattern
 * `@vue-html-bridge/settings` itself uses for core's `GenerateOptions`, and
 * `@vue-html-bridge/adapter-markuplint` uses for
 * `@vue-html-bridge/adapter-testkit`.
 */
export interface ResolvedValidatorSetting {
  adapter: string;
  enabled: boolean;
  settings?: unknown;
}

export interface LoadAdaptersTrust {
  workspaceTrusted: boolean;
  externalAdapters: "disabled" | "trusted-workspace-only";
}

/**
 * Resolves and dynamically imports an external adapter package rooted at
 * `workspaceRoot`, returning the raw imported module (namespace object).
 * Injected so tests can fake resolution without real npm packages on disk,
 * and so a future resolver (e.g. Yarn PnP — ADR-0008) can be swapped in
 * without an API break. Defaults to `nodeModuleResolver`.
 *
 * Reject with `AdapterModuleResolutionError` (resolver.ts) for a resolution
 * failure (the package cannot be found) — `loadConfiguredAdapters` reports
 * that as `"resolution-failed"`. Any other rejection is treated as the
 * imported module itself throwing while evaluating, reported as
 * `"import-threw"`.
 */
export type AdapterModuleResolver = (
  specifier: string,
  workspaceRoot: string,
) => Promise<unknown>;

export interface LoadAdaptersRequest {
  validators: readonly ResolvedValidatorSetting[];
  workspaceRoot: string;
  trust: LoadAdaptersTrust;
  /** Built-in adapters, keyed by adapter id (e.g. "markuplint"). Hosts inject their bundled adapters here. */
  builtins: ReadonlyMap<string, HtmlValidatorAdapter<unknown>>;
  /** Module resolution/import, injected for tests and future PnP support. Defaults to workspace Node resolution. */
  moduleResolver?: AdapterModuleResolver;
  logger?: AdapterLogger;
}

export interface LoadedAdapter {
  adapter: HtmlValidatorAdapter<unknown>;
  settings: unknown;
  enabled: boolean;
  /** The validators[].adapter string this instance came from. */
  entryKey: string;
}

export type AdapterLoadFailureKind =
  | "external-adapters-disabled" // externalAdapters !== "trusted-workspace-only"
  | "workspace-not-trusted"
  | "invalid-specifier" // not a plain npm package specifier
  | "resolution-failed"
  | "import-threw"
  | "invalid-shape" // fails validator-api runtime-check
  | "api-version-mismatch"
  | "duplicate-runtime-id"; // two loaded adapters expose the same adapter.id

export interface AdapterLoadFailure {
  /** The validators[].adapter string. */
  specifier: string;
  kind: AdapterLoadFailureKind;
  message: string;
  /** Stable key for host-side notice deduplication: specifier + kind. */
  dedupeKey: string;
}

export interface LoadAdaptersResult {
  /** Loaded, runtime-validated adapters paired with their settings — ready for createWorkspaceAnalyzer. */
  adapters: readonly LoadedAdapter[];
  /** Structured failures, deduplicated and deterministically ordered. */
  failures: readonly AdapterLoadFailure[];
}
