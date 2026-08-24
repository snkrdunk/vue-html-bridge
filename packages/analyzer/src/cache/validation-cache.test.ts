import { describe, expect, it } from "vitest";
import { hashSettings, validationCacheKey } from "./validation-cache.js";

describe("validation cache key (analyzer.md §10.2)", () => {
  it("hashSettings is deterministic regardless of object key order", () => {
    expect(hashSettings({ a: 1, b: 2 })).toBe(hashSettings({ b: 2, a: 1 }));
  });

  it("hashSettings changes when a value changes", () => {
    expect(hashSettings({ a: 1 })).not.toBe(hashSettings({ a: 2 }));
  });

  it("hashSettings does not throw on a circular reference", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => hashSettings(circular)).not.toThrow();
  });

  it("validationCacheKey changes with settingsHash, sourceFilename, or htmlHash independently", () => {
    const base = {
      settingsHash: "s1",
      sourceFilename: "/workspace/A.vue",
      htmlHash: "h1",
    };
    const key = validationCacheKey(base);
    expect(validationCacheKey({ ...base, settingsHash: "s2" })).not.toBe(key);
    expect(
      validationCacheKey({ ...base, sourceFilename: "/workspace/B.vue" }),
    ).not.toBe(key);
    expect(validationCacheKey({ ...base, htmlHash: "h2" })).not.toBe(key);
    expect(validationCacheKey({ ...base })).toBe(key);
  });

  it("is the same for a Windows-style backslash path and its forward-slash equivalent", () => {
    const base = { settingsHash: "s1", htmlHash: "h1" };
    expect(
      validationCacheKey({ ...base, sourceFilename: "C:\\workspace\\A.vue" }),
    ).toBe(
      validationCacheKey({ ...base, sourceFilename: "C:/workspace/A.vue" }),
    );
  });
});
