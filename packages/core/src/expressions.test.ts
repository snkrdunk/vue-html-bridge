import { describe, expect, it } from "vitest";
import { lengthComparisonSafety } from "./expressions.js";

describe("lengthComparisonSafety (core.md §4.5: conservative fallback for > 2-style predicates)", () => {
  const cases: [string, "safe" | "unsafe" | "not-a-length-comparison"][] = [
    // Bare truthiness check ("has any items") is equivalent to "> 0".
    ["items.length", "safe"],
    // Every threshold at or below what {0, 1, 2} can reach stays correlated.
    ["items.length > 0", "safe"],
    ["items.length > 1", "safe"],
    ["items.length >= 2", "safe"],
    ["items.length < 2", "safe"],
    ["items.length <= 1", "safe"],
    ["items.length === 2", "safe"],
    ["items.length !== 5", "safe"],
    // A threshold above 2 can never be true for any of our exemplars —
    // correlating it would silently hide a reachable state.
    ["items.length > 2", "unsafe"],
    ["items.length > 3", "unsafe"],
    ["items.length >= 3", "unsafe"],
    ["items.length < 0", "unsafe"],
    ["items.length === 5", "unsafe"],
    // The threshold can be on either side; the operator direction flips.
    ["2 < items.length", "unsafe"], // same as "items.length > 2"
    ["0 < items.length", "safe"], // same as "items.length > 0"
    ["2 <= items.length", "safe"], // same as "items.length >= 2"
    // Not this shape at all.
    ["items.length + 1 > 2", "not-a-length-comparison"],
    ["other.length > 2", "not-a-length-comparison"],
  ];

  for (const [expression, expected] of cases) {
    it(`"${expression}" is ${expected}`, () => {
      expect(lengthComparisonSafety(expression, "items.length")).toBe(expected);
    });
  }
});
