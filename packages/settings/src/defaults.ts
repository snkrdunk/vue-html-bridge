import type { ResolvedVueHtmlBridgeSettings } from "./schema.js";

/**
 * The §3.1 defaults table. `resolveSettings([])` (no layers at all) must
 * equal this exactly (settings.md §8 item 1) — it is both the fallback for
 * a field no layer touches, and the value an invalid field is pinned to
 * (§4 point 1).
 */
export const DEFAULT_SETTINGS: ResolvedVueHtmlBridgeSettings = Object.freeze({
  enabled: true,
  include: Object.freeze(["**/*.vue"]),
  exclude: Object.freeze(["**/node_modules/**"]),
  validateOnChange: true,
  validateOnSave: true,
  debounceMs: 200,
  maxConcurrency: undefined,
  warnVariantCount: undefined,
  customElements: Object.freeze([]),
  customDirectives: Object.freeze([]),
  externalAdapters: "disabled",
  validators: Object.freeze([
    Object.freeze({ adapter: "markuplint", enabled: true }),
  ]),
});
