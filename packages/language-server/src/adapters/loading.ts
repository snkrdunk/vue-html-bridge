// Adapter loading (language-server.md §10, adapter-loader.md): a thin
// wrapper over @vue-html-bridge/adapter-loader that injects the server's
// built-in Markuplint adapter, applies the built-in's own trust-based
// settings restriction (§4.2 — out of scope for the host-neutral loader
// itself), and hands back a ready-to-use `ConfiguredAdapter[]` for
// `createWorkspaceAnalyzer`/`reconfigure` plus the loader's structured
// failures for the caller to turn into per-workspace notices.
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
import { builtinMarkuplintSettings, BUILTIN_MARKUPLINT_ID } from "./trust.js";

const DEFAULT_BUILTINS: ReadonlyMap<
  string,
  HtmlValidatorAdapter<unknown>
> = new Map([[BUILTIN_MARKUPLINT_ID, markuplintAdapter]]);

export interface LoadAdaptersForSessionOptions {
  validators: readonly ResolvedValidatorSetting[];
  workspaceRoot: string;
  workspaceTrusted: boolean;
  externalAdapters: "disabled" | "trusted-workspace-only";
  moduleResolver?: AdapterModuleResolver;
  logger?: AdapterLogger;
  /** Overridable for tests (adapter-loader.md §6 item 8's shared contract fixture); defaults to the real built-in Markuplint adapter. */
  builtins?: ReadonlyMap<string, HtmlValidatorAdapter<unknown>>;
}

export interface LoadAdaptersForSessionResult {
  adapters: readonly ConfiguredAdapter[];
  failures: readonly AdapterLoadFailure[];
}

export async function loadAdaptersForSession(
  options: LoadAdaptersForSessionOptions,
): Promise<LoadAdaptersForSessionResult> {
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
