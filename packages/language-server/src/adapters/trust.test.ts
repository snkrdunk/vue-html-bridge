import { describe, expect, it } from "vitest";
import type { ResolvedValidatorSetting } from "@vue-html-bridge/settings";
import { builtinMarkuplintSettings } from "./trust.js";

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
