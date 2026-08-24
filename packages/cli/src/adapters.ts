// Adapter loading (cli.md §5, §6 step 1): a thin wrapper over
// @vue-html-bridge/adapter-loader, mirroring
// packages/language-server/src/adapters/loading.ts's shape — the loader
// invocation and failure handling are identical between the two hosts; only
// the trust *default* differs (cli.md §5: trusted by default, restricted by
// `--untrusted`, vs. the LSP's untrusted-by-default). The built-in
// Markuplint adapter's own trust-based settings restriction
// (packages/language-server/src/adapters/trust.ts's `builtinMarkuplintSettings`)
// is reused verbatim here since it is not exported by that internal module.
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import {
  loadConfiguredAdapters,
  type AdapterLoadFailure,
  type AdapterModuleResolver,
} from "@vue-html-bridge/adapter-loader";
import type { ConfiguredAdapter } from "@vue-html-bridge/analyzer";
import type { ResolvedValidatorSetting } from "@vue-html-bridge/settings";
import type {
  AdapterLogger,
  HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";

export const BUILTIN_MARKUPLINT_ID = "markuplint";

const DEFAULT_BUILTINS: ReadonlyMap<
  string,
  HtmlValidatorAdapter<unknown>
> = new Map([[BUILTIN_MARKUPLINT_ID, markuplintAdapter]]);

/**
 * cli.md §4.2/§5: in an untrusted run (`--untrusted`), the built-in
 * Markuplint adapter runs with its bundled, safe default config — no
 * `configFile`, forced `searchConfig: false`, so it never loads workspace JS
 * config or plugins. A trusted run uses the entry's own configured settings
 * unchanged.
 */
export function builtinMarkuplintSettings(
  entry: ResolvedValidatorSetting | undefined,
  workspaceTrusted: boolean,
): unknown {
  if (!workspaceTrusted) return { searchConfig: false };
  return entry?.settings ?? {};
}

export interface LoadAdaptersForRunOptions {
  validators: readonly ResolvedValidatorSetting[];
  workspaceRoot: string;
  workspaceTrusted: boolean;
  externalAdapters: "disabled" | "trusted-workspace-only";
  moduleResolver?: AdapterModuleResolver;
  logger?: AdapterLogger;
  /** Overridable for tests (adapter-loader.md §6 item 8's shared contract fixture); defaults to the real built-in Markuplint adapter. */
  builtins?: ReadonlyMap<string, HtmlValidatorAdapter<unknown>>;
}

export interface LoadAdaptersForRunResult {
  adapters: readonly ConfiguredAdapter[];
  failures: readonly AdapterLoadFailure[];
}

export async function loadAdaptersForRun(
  options: LoadAdaptersForRunOptions,
): Promise<LoadAdaptersForRunResult> {
  const markuplintEntry = options.validators.find(
    (entry) => entry.adapter === BUILTIN_MARKUPLINT_ID,
  );
  const result = await loadConfiguredAdapters({
    validators: options.validators,
    workspaceRoot: options.workspaceRoot,
    trust: {
      workspaceTrusted: options.workspaceTrusted,
      externalAdapters: options.externalAdapters,
    },
    builtins: options.builtins ?? DEFAULT_BUILTINS,
    moduleResolver: options.moduleResolver,
    logger: options.logger,
  });
  const adapters: ConfiguredAdapter[] = result.adapters.map((loaded) => {
    if (loaded.entryKey === BUILTIN_MARKUPLINT_ID) {
      return {
        adapter: loaded.adapter,
        settings: builtinMarkuplintSettings(
          markuplintEntry,
          options.workspaceTrusted,
        ),
        enabled: loaded.enabled,
      };
    }
    return {
      adapter: loaded.adapter,
      settings: loaded.settings,
      enabled: loaded.enabled,
    };
  });
  return { adapters, failures: result.failures };
}
