import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, dependsOn } from "./index.js";

describe("@vue-html-bridge/analyzer package skeleton", () => {
  it("exposes its own package name", () => {
    expect(PACKAGE_NAME).toBe("@vue-html-bridge/analyzer");
  });

  it("resolves its workspace dependencies through real ESM imports", () => {
    expect(dependsOn).toEqual([
      "vue-html-bridge",
      "@vue-html-bridge/validator-api",
    ]);
  });
});
