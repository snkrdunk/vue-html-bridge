import { describe, expect, it } from "vitest";
import { startLanguageServer } from "./index.js";

describe("@vue-html-bridge/language-server public API", () => {
  it("exposes startLanguageServer from the package root", () => {
    expect(typeof startLanguageServer).toBe("function");
  });
});
