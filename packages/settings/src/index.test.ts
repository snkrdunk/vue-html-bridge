import { describe, expect, it } from "vitest";
import {
  decomposeSettings,
  DEFAULT_SETTINGS,
  PACKAGE_NAME,
  resolveSettings,
  type VueHtmlBridgeSettingsInput,
} from "./index.js";

describe("@vue-html-bridge/settings", () => {
  it("exposes its own package name", () => {
    expect(PACKAGE_NAME).toBe("@vue-html-bridge/settings");
  });

  it("end-to-end: workspace layer + host layer -> resolve -> decompose", () => {
    const workspaceLayer: VueHtmlBridgeSettingsInput = {
      include: ["src/**/*.vue"],
      validators: [{ adapter: "markuplint", settings: { strict: true } }],
    };
    const hostLayer: VueHtmlBridgeSettingsInput = {
      debounceMs: 50,
      externalAdapters: "trusted-workspace-only",
    };

    const { settings, issues } = resolveSettings([workspaceLayer, hostLayer]);
    expect(issues).toEqual([]);
    expect(settings.include).toEqual(["src/**/*.vue"]);
    expect(settings.debounceMs).toBe(50);
    expect(settings.externalAdapters).toBe("trusted-workspace-only");
    // Untouched fields keep the package defaults.
    expect(settings.exclude).toEqual(DEFAULT_SETTINGS.exclude);

    const decomposed = decomposeSettings(settings);
    expect(decomposed.host.debounceMs).toBe(50);
    expect(decomposed.validators).toEqual([
      { adapter: "markuplint", enabled: true, settings: { strict: true } },
    ]);
    expect(decomposed.analyzer).toEqual({}); // maxConcurrency delegated
  });
});
