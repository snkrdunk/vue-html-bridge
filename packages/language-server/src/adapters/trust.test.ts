import { describe, expect, it } from "vitest";
import type { ResolvedValidatorSetting } from "@vue-html-bridge/settings";
import { buildConfiguredAdapters, builtinMarkuplintSettings } from "./trust.js";

describe("builtinMarkuplintSettings (language-server.md §4.2)", () => {
  it("forces searchConfig: false with no configFile in an untrusted workspace, regardless of the configured entry", () => {
    const entry: ResolvedValidatorSetting = {
      adapter: "markuplint",
      enabled: true,
      settings: { configFile: "/workspace/.markuplintrc", searchConfig: true },
    };
    expect(builtinMarkuplintSettings(entry, false)).toEqual({
      searchConfig: false,
    });
  });

  it("uses the entry's own settings unchanged in a trusted workspace", () => {
    const entry: ResolvedValidatorSetting = {
      adapter: "markuplint",
      enabled: true,
      settings: { configFile: "/workspace/.markuplintrc" },
    };
    expect(builtinMarkuplintSettings(entry, true)).toEqual({
      configFile: "/workspace/.markuplintrc",
    });
  });

  it("still forces the restricted default in an untrusted workspace with no entry at all", () => {
    expect(builtinMarkuplintSettings(undefined, false)).toEqual({
      searchConfig: false,
    });
  });
});

describe("buildConfiguredAdapters (§4.2, §10.1)", () => {
  it("includes the built-in markuplint adapter when validators[] names it enabled", () => {
    const adapters = buildConfiguredAdapters(
      [{ adapter: "markuplint", enabled: true }],
      true,
    );
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.adapter.id).toBe("markuplint");
    expect(adapters[0]!.enabled).toBe(true);
  });

  it("excludes it when validators[] explicitly disables it", () => {
    const adapters = buildConfiguredAdapters(
      [{ adapter: "markuplint", enabled: false }],
      true,
    );
    expect(adapters).toHaveLength(0);
  });

  it("excludes it when validators[] doesn't name it at all (an explicit override replaced the default)", () => {
    const adapters = buildConfiguredAdapters(
      [{ adapter: "some-other-adapter", enabled: true }],
      true,
    );
    expect(adapters).toHaveLength(0);
  });

  it("applies the untrusted-workspace restriction to the built-in adapter's settings", () => {
    const adapters = buildConfiguredAdapters(
      [
        {
          adapter: "markuplint",
          enabled: true,
          settings: { configFile: "/workspace/.markuplintrc" },
        },
      ],
      false,
    );
    expect(adapters[0]!.settings).toEqual({ searchConfig: false });
  });
});
