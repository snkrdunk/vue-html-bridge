/**
 * Layer validation and merging (settings.md §4). Resolution is one
 * normative operation shared by both hosts:
 *
 * 1. Each layer is validated independently. An unknown top-level field is a
 *    `warning` and is dropped from that layer. A field with an invalid type
 *    or an out-of-range value is an `error`, and that field is pinned to
 *    its package default *for that layer's contribution* — the layer still
 *    counts as having "touched" the field (with the default value), so a
 *    lower-precedence layer's value for the same field can never silently
 *    take effect in its place (§4 point 1, tested by §8 item 4).
 * 2. Validated layers are merged, lowest precedence first: each top-level
 *    field takes the value from the highest-precedence layer that defined
 *    it (arrays are fully replaced, never concatenated); a field no layer
 *    defines takes the package default.
 *
 * `resolveSettings` never has file/source context (`layers` are raw
 * values, not `SettingsFileResult`s), so issues it produces never set
 * `sourcePath` — only the loaders in loader.ts do that.
 */
import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  KNOWN_SETTINGS_FIELDS,
  RESERVED_SETTINGS_FIELDS,
  type KnownSettingsField,
  type ResolvedValidatorSetting,
  type ResolvedVueHtmlBridgeSettings,
  type SettingsIssue,
} from "./schema.js";

export function resolveSettings(layers: readonly unknown[]): {
  settings: ResolvedVueHtmlBridgeSettings;
  issues: readonly SettingsIssue[];
} {
  const issues: SettingsIssue[] = [];
  const validatedLayers: ValidatedLayer[] = [];
  for (const raw of layers) {
    const result = validateLayer(raw);
    validatedLayers.push(result.layer);
    issues.push(...result.issues);
  }

  const settings: ResolvedVueHtmlBridgeSettings = {
    enabled:
      resolveField(validatedLayers, "enabled") ?? DEFAULT_SETTINGS.enabled,
    include:
      resolveField(validatedLayers, "include") ?? DEFAULT_SETTINGS.include,
    exclude:
      resolveField(validatedLayers, "exclude") ?? DEFAULT_SETTINGS.exclude,
    validateOnChange:
      resolveField(validatedLayers, "validateOnChange") ??
      DEFAULT_SETTINGS.validateOnChange,
    validateOnSave:
      resolveField(validatedLayers, "validateOnSave") ??
      DEFAULT_SETTINGS.validateOnSave,
    debounceMs:
      resolveField(validatedLayers, "debounceMs") ??
      DEFAULT_SETTINGS.debounceMs,
    // maxConcurrency/warnVariantCount: absent-from-every-layer and
    // pinned-to-default-because-invalid both collapse to `undefined` here,
    // since DEFAULT_SETTINGS already delegates with `undefined` — no
    // special-casing needed beyond the other fields.
    maxConcurrency:
      resolveField(validatedLayers, "maxConcurrency") ??
      DEFAULT_SETTINGS.maxConcurrency,
    warnVariantCount:
      resolveField(validatedLayers, "warnVariantCount") ??
      DEFAULT_SETTINGS.warnVariantCount,
    customElements:
      resolveField(validatedLayers, "customElements") ??
      DEFAULT_SETTINGS.customElements,
    externalAdapters:
      resolveField(validatedLayers, "externalAdapters") ??
      DEFAULT_SETTINGS.externalAdapters,
    validators:
      resolveField(validatedLayers, "validators") ??
      DEFAULT_SETTINGS.validators,
  };

  return { settings, issues };
}

// ---------------------------------------------------------------------------
// Per-layer validation
// ---------------------------------------------------------------------------

interface ValidatedLayer {
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
  validators?: readonly ResolvedValidatorSetting[];
}

/**
 * Picks the value from the highest-precedence layer that actually "touched"
 * `field` (own-property presence, via `Object.hasOwn`, not `!== undefined`
 * — `maxConcurrency`/`warnVariantCount` can be legitimately, explicitly set
 * to `undefined` by pinning, and that must still win over a lower layer).
 * `layers` is lowest precedence first, so we scan from the end.
 */
function resolveField<K extends keyof ValidatedLayer>(
  layers: readonly ValidatedLayer[],
  field: K,
): ValidatedLayer[K] {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (layer !== undefined && Object.hasOwn(layer, field)) {
      return layer[field];
    }
  }
  return undefined;
}

function validateLayer(raw: unknown): {
  layer: ValidatedLayer;
  issues: SettingsIssue[];
} {
  const issues: SettingsIssue[] = [];
  const layer: ValidatedLayer = {};
  // Defensive: a layer that isn't even a plain object (a host bug, since
  // every real layer originates from JSON or flag-mapping code) contributes
  // nothing rather than throwing.
  if (!isPlainObject(raw)) return { layer, issues };

  for (const [key, rawValue] of Object.entries(raw)) {
    if (rawValue === undefined) continue; // treated as if the key were absent
    if ((RESERVED_SETTINGS_FIELDS as readonly string[]).includes(key)) {
      continue; // $schema / version: always accepted, always ignored
    }
    if (!isKnownField(key)) {
      issues.push(unknownField(key));
      continue;
    }
    switch (key) {
      case "enabled": {
        const result = validateBoolean(
          "enabled",
          rawValue,
          DEFAULT_SETTINGS.enabled,
        );
        layer.enabled = result.value;
        issues.push(...result.issues);
        break;
      }
      case "include": {
        const result = validateStringArray(
          "include",
          rawValue,
          DEFAULT_SETTINGS.include,
          { nonEmpty: true },
        );
        layer.include = result.value;
        issues.push(...result.issues);
        break;
      }
      case "exclude": {
        const result = validateStringArray(
          "exclude",
          rawValue,
          DEFAULT_SETTINGS.exclude,
        );
        layer.exclude = result.value;
        issues.push(...result.issues);
        break;
      }
      case "validateOnChange": {
        const result = validateBoolean(
          "validateOnChange",
          rawValue,
          DEFAULT_SETTINGS.validateOnChange,
        );
        layer.validateOnChange = result.value;
        issues.push(...result.issues);
        break;
      }
      case "validateOnSave": {
        const result = validateBoolean(
          "validateOnSave",
          rawValue,
          DEFAULT_SETTINGS.validateOnSave,
        );
        layer.validateOnSave = result.value;
        issues.push(...result.issues);
        break;
      }
      case "debounceMs": {
        const result = validateIntegerInRange(
          "debounceMs",
          rawValue,
          DEFAULT_SETTINGS.debounceMs,
          0,
          60000,
        );
        layer.debounceMs = result.value;
        issues.push(...result.issues);
        break;
      }
      case "maxConcurrency": {
        const result = validateDelegatedInteger("maxConcurrency", rawValue, 1);
        layer.maxConcurrency = result.value;
        issues.push(...result.issues);
        break;
      }
      case "warnVariantCount": {
        const result = validateDelegatedInteger(
          "warnVariantCount",
          rawValue,
          1,
        );
        layer.warnVariantCount = result.value;
        issues.push(...result.issues);
        break;
      }
      case "customElements": {
        const result = validateStringArray(
          "customElements",
          rawValue,
          DEFAULT_SETTINGS.customElements,
        );
        layer.customElements = result.value;
        issues.push(...result.issues);
        break;
      }
      case "externalAdapters": {
        const result = validateExternalAdapters(rawValue);
        layer.externalAdapters = result.value;
        issues.push(...result.issues);
        break;
      }
      case "validators": {
        const result = validateValidators(rawValue);
        layer.validators = result.value;
        issues.push(...result.issues);
        break;
      }
    }
  }
  return { layer, issues };
}

function isKnownField(key: string): key is KnownSettingsField {
  return (KNOWN_SETTINGS_FIELDS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

interface FieldOutcome<T> {
  value: T;
  issues: SettingsIssue[];
}

function ok<T>(value: T): FieldOutcome<T> {
  return { value, issues: [] };
}

function invalid<T>(value: T, issue: SettingsIssue): FieldOutcome<T> {
  return { value, issues: [issue] };
}

function validateBoolean(
  field: KnownSettingsField,
  raw: unknown,
  fallback: boolean,
): FieldOutcome<boolean> {
  if (typeof raw === "boolean") return ok(raw);
  return invalid(fallback, invalidType(field, "a boolean"));
}

function validateStringArray(
  field: KnownSettingsField,
  raw: unknown,
  fallback: readonly string[],
  options: { nonEmpty?: boolean } = {},
): FieldOutcome<readonly string[]> {
  if (
    !Array.isArray(raw) ||
    !raw.every((item): item is string => typeof item === "string")
  ) {
    return invalid(fallback, invalidType(field, "an array of strings"));
  }
  if (options.nonEmpty === true && raw.length === 0) {
    return invalid(
      fallback,
      outOfRange(field, `Setting "${field}" must be a non-empty array.`),
    );
  }
  return ok(raw);
}

function validateIntegerInRange(
  field: KnownSettingsField,
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): FieldOutcome<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return invalid(fallback, invalidType(field, "an integer"));
  }
  if (raw < min || raw > max) {
    return invalid(
      fallback,
      outOfRange(
        field,
        `Setting "${field}" must be between ${min} and ${max}.`,
      ),
    );
  }
  return ok(raw);
}

/** For `maxConcurrency`/`warnVariantCount`: absent means "delegate"; an invalid value is pinned to `undefined` (delegate), never a copied number. */
function validateDelegatedInteger(
  field: KnownSettingsField,
  raw: unknown,
  min: number,
): FieldOutcome<number | undefined> {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return invalid(undefined, invalidType(field, "an integer"));
  }
  if (raw < min) {
    return invalid(
      undefined,
      outOfRange(field, `Setting "${field}" must be >= ${min}.`),
    );
  }
  return ok(raw);
}

function validateExternalAdapters(
  raw: unknown,
): FieldOutcome<"disabled" | "trusted-workspace-only"> {
  if (raw === "disabled" || raw === "trusted-workspace-only") return ok(raw);
  return invalid(
    DEFAULT_SETTINGS.externalAdapters,
    invalidType("externalAdapters", '"disabled" or "trusted-workspace-only"'),
  );
}

/**
 * `validators` is validated per-item rather than pinned wholesale on the
 * first problem: unlike a scalar field, an array of independently
 * identified adapter configs has a natural smaller unit to drop (the one
 * bad entry) without discarding entries that were valid. This is a
 * deliberate, documented reading of settings.md §4 point 1 for this one
 * field — "a field is pinned to its default" still applies at the *whole
 * field* level only when the raw value isn't even an array (no smaller
 * unit exists then). `enabled` within one item falls back to its own
 * documented default (`true`, settings.md §3.1) while keeping the rest of
 * that item, for the same reason.
 */
function validateValidators(
  raw: unknown,
): FieldOutcome<readonly ResolvedValidatorSetting[]> {
  if (!Array.isArray(raw)) {
    return invalid(
      DEFAULT_SETTINGS.validators,
      invalidType("validators", "an array"),
    );
  }
  const issues: SettingsIssue[] = [];
  const items: ResolvedValidatorSetting[] = [];
  const seenAdapters = new Set<string>();

  raw.forEach((rawItem: unknown, index: number) => {
    const path = `validators[${index}]`;
    if (!isPlainObject(rawItem)) {
      issues.push(invalidType(path, "an object"));
      return;
    }
    const adapter = rawItem.adapter;
    if (typeof adapter !== "string" || adapter.trim().length === 0) {
      issues.push(invalidType(`${path}.adapter`, "a non-empty string"));
      return;
    }
    let enabled = true;
    if (rawItem.enabled !== undefined) {
      if (typeof rawItem.enabled === "boolean") {
        enabled = rawItem.enabled;
      } else {
        issues.push(invalidType(`${path}.enabled`, "a boolean"));
      }
    }
    if (seenAdapters.has(adapter)) {
      issues.push(duplicateAdapter(`${path}.adapter`, adapter));
      return; // first entry wins (settings.md §3.1)
    }
    seenAdapters.add(adapter);
    items.push({
      adapter,
      enabled,
      ...(rawItem.settings !== undefined ? { settings: rawItem.settings } : {}),
    });
  });

  return { value: items, issues };
}

// ---------------------------------------------------------------------------
// Issue constructors
// ---------------------------------------------------------------------------

function unknownField(path: string): SettingsIssue {
  return {
    severity: "warning",
    code: "unknown-field",
    path,
    message: `Unknown setting "${path}" was ignored.`,
  };
}

function invalidType(path: string, expected: string): SettingsIssue {
  return {
    severity: "error",
    code: "invalid-type",
    path,
    message: `Setting "${path}" must be ${expected}; using the default instead.`,
  };
}

function outOfRange(path: string, message: string): SettingsIssue {
  return { severity: "error", code: "out-of-range", path, message };
}

function duplicateAdapter(path: string, adapter: string): SettingsIssue {
  return {
    severity: "error",
    code: "duplicate-adapter",
    path,
    message: `Duplicate validator entry for adapter "${adapter}"; the first entry wins.`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
