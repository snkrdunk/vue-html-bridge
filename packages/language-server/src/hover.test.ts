import { describe, expect, it } from "vitest";
import type { SourceDiagnostic } from "@vue-html-bridge/analyzer";
import { buildHoverContent, findHoverDiagnostic } from "./hover.js";

function diagnostic(
  overrides: Partial<SourceDiagnostic> = {},
): SourceDiagnostic {
  return {
    id: "d1",
    origin: "validator",
    sourceRange: { filename: "/p/A.vue", start: 5, end: 10 },
    relatedInformation: [],
    severity: "warning",
    message: "problem",
    code: "some-rule",
    evidence: {
      variantCount: 1,
      variantIds: ["v1"],
      exampleDecisions: [],
      truncated: false,
    },
    ...overrides,
  };
}

describe("findHoverDiagnostic (language-server.md §8)", () => {
  it("matches a non-empty range with start <= offset < end", () => {
    const d = diagnostic({
      sourceRange: { filename: "/p/A.vue", start: 5, end: 10 },
    });
    expect(findHoverDiagnostic([d], 5)).toBe(d);
    expect(findHoverDiagnostic([d], 9)).toBe(d);
    expect(findHoverDiagnostic([d], 10)).toBeUndefined();
    expect(findHoverDiagnostic([d], 4)).toBeUndefined();
  });

  it("matches a zero-width range only when offset equals start", () => {
    const d = diagnostic({
      sourceRange: { filename: "/p/A.vue", start: 5, end: 5 },
    });
    expect(findHoverDiagnostic([d], 5)).toBe(d);
    expect(findHoverDiagnostic([d], 4)).toBeUndefined();
    expect(findHoverDiagnostic([d], 6)).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    const d = diagnostic();
    expect(findHoverDiagnostic([d], 100)).toBeUndefined();
    expect(findHoverDiagnostic([], 5)).toBeUndefined();
  });

  it("orders overlapping matches by severity, then shorter range, then adapterId/code", () => {
    const range = { filename: "/p/A.vue", start: 5, end: 10 };
    const warningWide = diagnostic({
      id: "a",
      severity: "warning",
      sourceRange: range,
      code: "z-rule",
    });
    const errorNarrow = diagnostic({
      id: "b",
      severity: "error",
      sourceRange: { filename: "/p/A.vue", start: 6, end: 8 },
      code: "a-rule",
    });
    expect(findHoverDiagnostic([warningWide, errorNarrow], 7)).toBe(
      errorNarrow,
    );

    const errorWide = diagnostic({
      id: "c",
      severity: "error",
      sourceRange: range,
      code: "z-rule",
    });
    const errorAlsoWide = diagnostic({
      id: "d",
      severity: "error",
      sourceRange: range,
      code: "a-rule",
    });
    expect(findHoverDiagnostic([errorWide, errorAlsoWide], 7)).toBe(
      errorAlsoWide,
    );
  });
});

describe("buildHoverContent (§8)", () => {
  it("shows the adapter/code heading and the message", () => {
    const content = buildHoverContent(
      diagnostic({
        adapterId: "markuplint",
        code: "invalid-attr",
        message: "bad value",
      }),
    );
    expect(content).toContain("**markuplint · invalid-attr**");
    expect(content).toContain("bad value");
  });

  it("shows variant evidence only when there is more than one variant", () => {
    const single = buildHoverContent(
      diagnostic({
        evidence: {
          variantCount: 1,
          variantIds: ["v1"],
          exampleDecisions: [],
          truncated: false,
        },
      }),
    );
    expect(single).not.toContain("Occurs in");

    const multiple = buildHoverContent(
      diagnostic({
        evidence: {
          variantCount: 2,
          variantIds: ["v1", "v2"],
          exampleDecisions: [],
          truncated: false,
        },
      }),
    );
    expect(multiple).toContain("Occurs in 2 variants: v1, v2");
  });

  it("shows a representative original validator message plus a count of the rest", () => {
    const content = buildHoverContent(
      diagnostic({
        evidence: {
          variantCount: 1,
          variantIds: ["v1"],
          exampleDecisions: [],
          truncated: false,
          originalValidatorMessages: ["first message", "second message"],
        },
      }),
    );
    expect(content).toContain("**Validator detail**");
    expect(content).toContain("first message (+1 more)");
  });
});
