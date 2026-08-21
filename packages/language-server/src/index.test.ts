import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, dependsOn } from "./index.js";

describe("@vue-html-bridge/language-server package skeleton", () => {
  it("exposes its own package name", () => {
    expect(PACKAGE_NAME).toBe("@vue-html-bridge/language-server");
  });

  it("resolves its workspace dependencies through real ESM imports", () => {
    expect(dependsOn).toEqual([
      "@vue-html-bridge/analyzer",
      "@vue-html-bridge/adapter-markuplint",
      "@vue-html-bridge/validator-api",
      "@vue-html-bridge/settings",
    ]);
  });
});
