import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { resolveSettings } from "./resolve.js";

describe("resolveSettings: defaults (§8 item 1)", () => {
  it("resolveSettings([]) equals the §3.1 defaults table exactly", () => {
    const { settings, issues } = resolveSettings([]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(issues).toEqual([]);
  });

  it("delegated fields resolve to undefined, and the default validators entry is present", () => {
    const { settings } = resolveSettings([]);
    expect(settings.maxConcurrency).toBeUndefined();
    expect(settings.warnVariantCount).toBeUndefined();
    expect(settings.validators).toEqual([
      { adapter: "markuplint", enabled: true },
    ]);
  });
});

describe("resolveSettings: merge matrix (§8 item 2)", () => {
  it("merges disjoint fields from lower and higher layers", () => {
    const { settings, issues } = resolveSettings([
      { enabled: false },
      { debounceMs: 500 },
    ]);
    expect(issues).toEqual([]);
    expect(settings.enabled).toBe(false);
    expect(settings.debounceMs).toBe(500);
  });

  it("a higher-precedence layer overrides a lower one for the same scalar field", () => {
    const { settings } = resolveSettings([
      { debounceMs: 100 },
      { debounceMs: 900 },
    ]);
    expect(settings.debounceMs).toBe(900);
  });

  it("arrays are fully replaced by the higher-precedence layer, never concatenated", () => {
    const { settings } = resolveSettings([
      { include: ["a/**/*.vue", "b/**/*.vue"] },
      { include: ["only/**/*.vue"] },
    ]);
    expect(settings.include).toEqual(["only/**/*.vue"]);
  });

  it("a field only the lower layer sets survives an unrelated higher layer", () => {
    const { settings } = resolveSettings([
      { exclude: ["**/fixtures/**"] },
      { enabled: false },
    ]);
    expect(settings.exclude).toEqual(["**/fixtures/**"]);
  });

  it("precedence order is lowest-first: the last array element wins", () => {
    const { settings } = resolveSettings([
      { debounceMs: 1 },
      { debounceMs: 2 },
      { debounceMs: 3 },
    ]);
    expect(settings.debounceMs).toBe(3);
  });
});

describe("resolveSettings: validation (§8 item 3)", () => {
  it("an unknown top-level field is a warning and is dropped", () => {
    const { settings, issues } = resolveSettings([{ totallyMadeUp: true }]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(issues).toEqual([
      {
        severity: "warning",
        code: "unknown-field",
        path: "totallyMadeUp",
        message: 'Unknown setting "totallyMadeUp" was ignored.',
      },
    ]);
  });

  it.each([
    ["enabled", "not-a-boolean", true],
    ["validateOnChange", 1, true],
    ["validateOnSave", null, true],
    ["debounceMs", "200", 200],
    ["maxConcurrency", "4", undefined],
    ["warnVariantCount", 3.5, undefined],
    ["customElements", "not-an-array", []],
    ["externalAdapters", "sometimes", "disabled"],
    ["include", { not: "an array" }, ["**/*.vue"]],
    ["validators", "not-an-array", [{ adapter: "markuplint", enabled: true }]],
  ] as const)(
    "invalid type for %s is an error and pins the field to its default",
    (field, badValue, expectedDefault) => {
      const { settings, issues } = resolveSettings([{ [field]: badValue }]);
      expect(settings[field]).toEqual(expectedDefault);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: "error",
        code: "invalid-type",
      });
    },
  );

  it.each([
    ["debounceMs", -1],
    ["debounceMs", 60001],
    ["maxConcurrency", 0],
    ["warnVariantCount", 0],
  ] as const)(
    "out-of-range %s=%s is an error and pins the field to its default",
    (field, badValue) => {
      const { settings, issues } = resolveSettings([{ [field]: badValue }]);
      expect(settings[field]).toBe(DEFAULT_SETTINGS[field]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: "error",
        code: "out-of-range",
      });
    },
  );

  it("an empty include array is out-of-range (must be non-empty)", () => {
    const { settings, issues } = resolveSettings([{ include: [] }]);
    expect(settings.include).toEqual(DEFAULT_SETTINGS.include);
    expect(issues).toMatchObject([{ severity: "error", code: "out-of-range" }]);
  });

  it("an empty exclude array is valid (no non-empty constraint)", () => {
    const { settings, issues } = resolveSettings([{ exclude: [] }]);
    expect(settings.exclude).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("$schema and version are accepted and ignored", () => {
    const { settings, issues } = resolveSettings([
      {
        $schema: "./node_modules/@vue-html-bridge/settings/schema.json",
        version: 1,
      },
    ]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(issues).toEqual([]);
  });

  it("detects a duplicate adapter id within one layer; the first entry wins", () => {
    const { settings, issues } = resolveSettings([
      {
        validators: [
          { adapter: "markuplint", enabled: true },
          { adapter: "markuplint", enabled: false },
        ],
      },
    ]);
    expect(settings.validators).toEqual([
      { adapter: "markuplint", enabled: true },
    ]);
    expect(issues).toEqual([
      {
        severity: "error",
        code: "duplicate-adapter",
        path: "validators[1].adapter",
        message:
          'Duplicate validator entry for adapter "markuplint"; the first entry wins.',
      },
    ]);
  });

  it("drops one structurally invalid validators[] item without discarding the rest of the array", () => {
    const { settings, issues } = resolveSettings([
      {
        validators: [
          { adapter: "markuplint" },
          { notAnAdapterField: true },
          "not even an object",
          { adapter: "" },
        ],
      },
    ]);
    expect(settings.validators).toEqual([
      { adapter: "markuplint", enabled: true },
    ]);
    expect(issues.map((issue) => issue.path)).toEqual([
      "validators[1].adapter",
      "validators[2]",
      "validators[3].adapter",
    ]);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  it("an invalid enabled within one validators[] item falls back to true but keeps the item", () => {
    const { settings, issues } = resolveSettings([
      { validators: [{ adapter: "markuplint", enabled: "yes" }] },
    ]);
    expect(settings.validators).toEqual([
      { adapter: "markuplint", enabled: true },
    ]);
    expect(issues).toEqual([
      {
        severity: "error",
        code: "invalid-type",
        path: "validators[0].enabled",
        message:
          'Setting "validators[0].enabled" must be a boolean; using the default instead.',
      },
    ]);
  });

  it("preserves opaque validators[].settings untouched", () => {
    const { settings } = resolveSettings([
      {
        validators: [
          { adapter: "markuplint", settings: { configFile: ".markuplintrc" } },
        ],
      },
    ]);
    expect(settings.validators).toEqual([
      {
        adapter: "markuplint",
        enabled: true,
        settings: { configFile: ".markuplintrc" },
      },
    ]);
  });
});

describe("resolveSettings: pinning beats lower layers (§8 item 4)", () => {
  it("an invalid externalAdapters in the top layer resolves to the safe default, never a lower layer's valid value", () => {
    const { settings, issues } = resolveSettings([
      { externalAdapters: "trusted-workspace-only" },
      { externalAdapters: "YOLO" },
    ]);
    expect(settings.externalAdapters).toBe("disabled");
    expect(issues).toEqual([
      {
        severity: "error",
        code: "invalid-type",
        path: "externalAdapters",
        message:
          'Setting "externalAdapters" must be "disabled" or "trusted-workspace-only"; using the default instead.',
      },
    ]);
  });

  it("a still-higher, validly-set layer can override an invalid middle layer's pin", () => {
    // Documents a deliberate reading of settings.md §4 point 1: pinning
    // only prevents a *lower* layer from taking effect in an invalid
    // layer's place; it doesn't prevent an even-higher, validly-set layer
    // from normally overriding it, same as any other field-by-field merge.
    const { settings, issues } = resolveSettings([
      { externalAdapters: "trusted-workspace-only" }, // lowest: valid
      { externalAdapters: "YOLO" }, // middle: invalid, pinned to "disabled"
      { externalAdapters: "trusted-workspace-only" }, // highest: valid again
    ]);
    expect(settings.externalAdapters).toBe("trusted-workspace-only");
    expect(issues).toMatchObject([{ code: "invalid-type" }]);
  });
});
