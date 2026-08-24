import type {
  ResolvedValidatorSetting,
  ResolvedVueHtmlBridgeSettings,
} from "./schema.js";

/**
 * Structurally declared here rather than imported from `vue-html-bridge`
 * (core), per settings.md §2: this package has zero internal runtime
 * dependencies, so any future host can import it without pulling in core.
 * Agreement with the real `GenerateOptions` (core.md, core's `src/types.ts`)
 * is pinned by the contract test in `contract.test.ts` (settings.md §8 item
 * 8), which does take a devDependency-only edge on `vue-html-bridge` (see
 * `scripts/check-dependency-graph.mjs`'s `EXPECTED_INTERNAL_DEPS`) — types
 * only, erased at build time, so it adds no runtime dependency.
 */
export interface GenerateOptions {
  warnVariantCount?: number;
  customElements?: readonly string[];
}

/** Structurally matches analyzer's `CreateWorkspaceAnalyzerOptions`/`ReconfigureOptions` `maxConcurrency` field (analyzer.md §2). */
export interface AnalyzerOptions {
  maxConcurrency?: number;
}

export interface HostSettings {
  enabled: boolean;
  include: readonly string[];
  exclude: readonly string[];
  validateOnChange: boolean;
  validateOnSave: boolean;
  debounceMs: number;
  externalAdapters: "disabled" | "trusted-workspace-only";
}

export interface DecomposedSettings {
  generateOptions: GenerateOptions;
  analyzer: AnalyzerOptions;
  validators: readonly ResolvedValidatorSetting[];
  host: HostSettings;
}

/**
 * Splits resolved settings into the shape each downstream package consumes
 * (settings.md §6). A delegated field (`maxConcurrency`, `warnVariantCount`
 * = `undefined`) is omitted from the decomposed options entirely — not
 * included with an `undefined` value — so the downstream package's own
 * default takes over; this package never copies another package's default.
 */
export function decomposeSettings(
  settings: ResolvedVueHtmlBridgeSettings,
): DecomposedSettings {
  return {
    generateOptions: {
      ...(settings.warnVariantCount !== undefined
        ? { warnVariantCount: settings.warnVariantCount }
        : {}),
      customElements: settings.customElements,
    },
    analyzer: {
      ...(settings.maxConcurrency !== undefined
        ? { maxConcurrency: settings.maxConcurrency }
        : {}),
    },
    validators: settings.validators,
    host: {
      enabled: settings.enabled,
      include: settings.include,
      exclude: settings.exclude,
      validateOnChange: settings.validateOnChange,
      validateOnSave: settings.validateOnSave,
      debounceMs: settings.debounceMs,
      externalAdapters: settings.externalAdapters,
    },
  };
}
