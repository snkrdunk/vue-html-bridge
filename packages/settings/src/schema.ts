/**
 * The shared settings schema (settings.md §3). This is the single source of
 * truth for the input and resolved shapes: every configuration layer — a
 * JSON file, LSP `workspace/configuration`, CLI flags — provides the input
 * form, where every field is optional; every consumer only ever sees the
 * resolved form, where every field (other than the two delegated ones) has
 * a concrete value.
 */

/** One entry of the `validators` list, as a layer provides it. */
export interface ValidatorSettingInput {
  adapter: string;
  /** default: `true` */
  enabled?: boolean;
  /** Opaque, adapter-specific. Never interpreted by this package. */
  settings?: unknown;
}

/** What one configuration layer provides. All fields optional. */
export interface VueHtmlBridgeSettingsInput {
  /**
   * Reserved (settings.md §3.1): a `$schema` reference for editor tooling.
   * Always accepted and ignored by `resolveSettings` — it never becomes
   * part of the resolved settings.
   */
  $schema?: string;
  /**
   * Reserved for a future settings schema version (settings.md §3.1).
   * Always accepted and ignored by `resolveSettings` today.
   */
  version?: unknown;
  enabled?: boolean;
  include?: readonly string[];
  exclude?: readonly string[];
  validateOnChange?: boolean;
  validateOnSave?: boolean;
  debounceMs?: number;
  maxConcurrency?: number;
  warnVariantCount?: number;
  customElements?: readonly string[];
  externalAdapters?: "disabled" | "trusted-workspace-only";
  validators?: readonly ValidatorSettingInput[];
}

/** One entry of the `validators` list, as resolution produces it. */
export interface ResolvedValidatorSetting {
  adapter: string;
  enabled: boolean;
  settings?: unknown;
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
  externalAdapters: "disabled" | "trusted-workspace-only";
  validators: readonly ResolvedValidatorSetting[];
}

export interface SettingsIssue {
  severity: "warning" | "error";
  code:
    | "unknown-field"
    | "invalid-type"
    | "out-of-range"
    | "duplicate-adapter"
    | "file-missing"
    | "file-unreadable"
    | "parse-error";
  path: string;
  message: string;
  /** Absolute path of the settings file the layer came from, when applicable. */
  sourcePath?: string;
}

/** The schema's known top-level fields, in §3.1 table order. */
export const KNOWN_SETTINGS_FIELDS = [
  "enabled",
  "include",
  "exclude",
  "validateOnChange",
  "validateOnSave",
  "debounceMs",
  "maxConcurrency",
  "warnVariantCount",
  "customElements",
  "externalAdapters",
  "validators",
] as const;

export type KnownSettingsField = (typeof KNOWN_SETTINGS_FIELDS)[number];

/**
 * Top-level keys reserved for future use (settings.md §3.1). Always
 * accepted and never validated, so a schema version can be introduced
 * later without a breaking change.
 */
export const RESERVED_SETTINGS_FIELDS = ["$schema", "version"] as const;
