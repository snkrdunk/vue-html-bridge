import type { DecomposedSettings } from "./decompose.js";
import type { ResolvedVueHtmlBridgeSettings } from "./schema.js";

/**
 * A single resolved-settings example paired with its expected decomposition
 * (settings.md §6 table, §8 item 7). Exported so this exact fixture can be
 * reused verbatim by the language-server and CLI test suites once they
 * consume this package — routing a settings field to the wrong downstream
 * consumer (or forgetting to route a new field at all) then fails in every
 * suite that imports this fixture, not just here.
 *
 * Deliberately exercises both delegated fields in different states:
 * `maxConcurrency` is set (kept in `analyzer`), `warnVariantCount` is
 * `undefined` (omitted from `generateOptions` entirely).
 */
export const SETTINGS_DECOMPOSITION_FIXTURE: {
  resolved: ResolvedVueHtmlBridgeSettings;
  decomposed: DecomposedSettings;
} = {
  resolved: {
    enabled: true,
    include: ["src/**/*.vue"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    validateOnChange: false,
    validateOnSave: true,
    debounceMs: 500,
    maxConcurrency: 3,
    warnVariantCount: undefined,
    customElements: ["my-widget"],
    customDirectives: [{ name: "src", attributes: { src: "$value" } }],
    externalAdapters: "trusted-workspace-only",
    validators: [
      { adapter: "markuplint", enabled: true },
      {
        adapter: "@acme/vue-html-bridge-adapter-vnu",
        enabled: false,
        settings: { strict: true },
      },
    ],
  },
  decomposed: {
    generateOptions: {
      customElements: ["my-widget"],
      customDirectives: [{ name: "src", attributes: { src: "$value" } }],
    },
    analyzer: {
      maxConcurrency: 3,
    },
    validators: [
      { adapter: "markuplint", enabled: true },
      {
        adapter: "@acme/vue-html-bridge-adapter-vnu",
        enabled: false,
        settings: { strict: true },
      },
    ],
    host: {
      enabled: true,
      include: ["src/**/*.vue"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      validateOnChange: false,
      validateOnSave: true,
      debounceMs: 500,
      externalAdapters: "trusted-workspace-only",
    },
  },
};
