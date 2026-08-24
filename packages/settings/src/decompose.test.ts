import { describe, expect, it } from "vitest";
import { decomposeSettings } from "./decompose.js";
import { SETTINGS_DECOMPOSITION_FIXTURE } from "./decomposition-fixture.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

describe("decomposeSettings: table parity (§8 item 7)", () => {
  it("matches the shared decomposition fixture", () => {
    const { resolved, decomposed } = SETTINGS_DECOMPOSITION_FIXTURE;
    expect(decomposeSettings(resolved)).toEqual(decomposed);
  });

  it("omits both delegated fields entirely (not as `undefined` values) when neither is set", () => {
    const result = decomposeSettings(DEFAULT_SETTINGS);
    expect(Object.hasOwn(result.analyzer, "maxConcurrency")).toBe(false);
    expect(Object.hasOwn(result.generateOptions, "warnVariantCount")).toBe(
      false,
    );
    expect(result.analyzer).toEqual({});
  });

  it("keeps a delegated field when it is explicitly set", () => {
    const result = decomposeSettings({
      ...DEFAULT_SETTINGS,
      maxConcurrency: 8,
      warnVariantCount: 512,
    });
    expect(result.analyzer).toEqual({ maxConcurrency: 8 });
    expect(result.generateOptions).toEqual({
      warnVariantCount: 512,
      customElements: [],
    });
  });

  it("routes validators through unchanged", () => {
    const validators = [{ adapter: "markuplint", enabled: true }];
    const result = decomposeSettings({ ...DEFAULT_SETTINGS, validators });
    expect(result.validators).toBe(validators);
  });

  it("routes the host-only fields into `host`", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      enabled: false,
      include: ["x/**/*.vue"],
      exclude: ["y/**"],
      validateOnChange: false,
      validateOnSave: false,
      debounceMs: 42,
      externalAdapters: "trusted-workspace-only" as const,
    };
    const result = decomposeSettings(settings);
    expect(result.host).toEqual({
      enabled: false,
      include: ["x/**/*.vue"],
      exclude: ["y/**"],
      validateOnChange: false,
      validateOnSave: false,
      debounceMs: 42,
      externalAdapters: "trusted-workspace-only",
    });
  });
});
