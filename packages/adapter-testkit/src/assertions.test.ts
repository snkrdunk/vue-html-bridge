import { describe, expect, it } from "vitest";
import { jsonEqual, normalizeForJson } from "./assertions.js";

describe("normalizeForJson (§3.9)", () => {
  it("does not flag a shared, non-circular reference reached via two different paths", () => {
    const shared = { x: 1 };
    const value = { a: shared, b: shared };
    expect(() => normalizeForJson(value)).not.toThrow();
    expect(normalizeForJson(value)).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("still rejects a genuine circular reference (a value that contains itself)", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(() => normalizeForJson(value)).toThrow(/circular reference/);
  });

  it("allows the same array to appear twice as sibling values, not just objects", () => {
    const shared = [1, 2, 3];
    const value = { a: shared, b: shared };
    expect(() => normalizeForJson(value)).not.toThrow();
  });

  it("drops undefined-valued properties, matching JSON.stringify", () => {
    expect(normalizeForJson({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("rejects a non-finite number", () => {
    expect(() => normalizeForJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      /non-finite number/,
    );
  });
});

describe("jsonEqual", () => {
  it("treats {a: undefined} and {} as equal, and is unaffected by shared references", () => {
    const shared = { x: 1 };
    expect(jsonEqual({ a: undefined, b: shared }, { b: shared })).toBe(true);
  });
});
