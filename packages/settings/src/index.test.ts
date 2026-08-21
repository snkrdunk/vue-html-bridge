import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@vue-html-bridge/settings package skeleton", () => {
  it("exposes its own package name", () => {
    expect(PACKAGE_NAME).toBe("@vue-html-bridge/settings");
  });
});
