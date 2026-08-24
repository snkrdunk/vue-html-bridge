import { describe, expect, it } from "vitest";
import { normalizeFilenameForCacheKey } from "./filename-key.js";

describe("normalizeFilenameForCacheKey (analyzer.md §10.2/§10.3)", () => {
  it("converts backslash path separators to forward slashes", () => {
    expect(normalizeFilenameForCacheKey("C:\\workspace\\A.vue")).toBe(
      "C:/workspace/A.vue",
    );
  });

  it("leaves an already-forward-slash path unchanged", () => {
    expect(normalizeFilenameForCacheKey("/workspace/A.vue")).toBe(
      "/workspace/A.vue",
    );
  });

  it("does not case-fold — case sensitivity is filesystem-dependent, not decidable here", () => {
    expect(normalizeFilenameForCacheKey("/workspace/A.vue")).not.toBe(
      normalizeFilenameForCacheKey("/workspace/a.vue"),
    );
  });
});
