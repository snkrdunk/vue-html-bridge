import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, dependsOn } from "./index.js";

describe("@vue-html-bridge/adapter-testkit package skeleton", () => {
  it("exposes its own package name", () => {
    expect(PACKAGE_NAME).toBe("@vue-html-bridge/adapter-testkit");
  });

  it("resolves its workspace dependencies through real ESM imports", () => {
    expect(dependsOn).toEqual(["@vue-html-bridge/validator-api"]);
  });
});
