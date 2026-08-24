import {
  DiagnosticSeverity,
  PositionEncodingKind,
} from "vscode-languageserver/node";
import { describe, expect, it } from "vitest";
import type { SourceDiagnostic } from "@vue-html-bridge/analyzer";
import { sortLspDiagnostics, toLspDiagnostic } from "./diagnostics.js";
import { createPositionIndex } from "./positions.js";

const URI = "file:///p/A.vue";
const ENCODING = PositionEncodingKind.UTF16;

function diagnostic(
  overrides: Partial<SourceDiagnostic> = {},
): SourceDiagnostic {
  return {
    id: "d1",
    origin: "validator",
    sourceRange: { filename: "/p/A.vue", start: 0, end: 1 },
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

describe("toLspDiagnostic (language-server.md §7.1)", () => {
  it("maps severity, source, code, and the diagnostic id into data", () => {
    const index = createPositionIndex("0123456789");
    const lsp = toLspDiagnostic(
      URI,
      index,
      ENCODING,
      diagnostic({
        adapterId: "markuplint",
        severity: "error",
        code: "invalid-attr",
      }),
    );
    expect(lsp.severity).toBe(DiagnosticSeverity.Error);
    expect(lsp.source).toBe("vue-html-bridge/markuplint");
    expect(lsp.code).toBe("invalid-attr");
    expect(lsp.data).toEqual({ diagnosticId: "d1" });
  });

  it("falls back to the bare bridge source when there is no adapterId (a core diagnostic)", () => {
    const index = createPositionIndex("0123456789");
    const lsp = toLspDiagnostic(
      URI,
      index,
      ENCODING,
      diagnostic({ origin: "core", code: "vue-html-bridge/x" }),
    );
    expect(lsp.source).toBe("vue-html-bridge");
  });

  it("converts UTF-16 offsets across an emoji surrogate pair correctly", () => {
    const text = '<p>\u{1F600}</p><img src="a.png">'; // "<p>" (3) + emoji (2 code units) + ...
    const index = createPositionIndex(text);
    const start = text.indexOf('src="a.png"');
    const lsp = toLspDiagnostic(
      URI,
      index,
      ENCODING,
      diagnostic({
        sourceRange: { filename: "/p/A.vue", start, end: start + 3 },
      }),
    );
    expect(lsp.range).toEqual({
      start: { line: 0, character: start },
      end: { line: 0, character: start + 3 },
    });
  });

  it("keeps relatedInformation attached to the same document URI (§7.1)", () => {
    const index = createPositionIndex("0123456789");
    const lsp = toLspDiagnostic(
      URI,
      index,
      ENCODING,
      diagnostic({
        relatedInformation: [
          {
            sourceRange: { filename: "/p/A.vue", start: 2, end: 4 },
            message: "also here",
          },
        ],
      }),
    );
    expect(lsp.relatedInformation).toHaveLength(1);
    expect(lsp.relatedInformation?.[0]?.location.uri).toBe("file:///p/A.vue");
  });
});

describe("sortLspDiagnostics (§7.2)", () => {
  it("orders by range, then severity, then source, then code, then message", () => {
    const index = createPositionIndex("0123456789");
    const later = toLspDiagnostic(
      URI,
      index,
      ENCODING,
      diagnostic({
        id: "a",
        sourceRange: { filename: "/p/A.vue", start: 5, end: 6 },
      }),
    );
    const earlier = toLspDiagnostic(
      URI,
      index,
      ENCODING,
      diagnostic({
        id: "b",
        sourceRange: { filename: "/p/A.vue", start: 1, end: 2 },
      }),
    );
    const sorted = sortLspDiagnostics([later, earlier]);
    expect(sorted).toEqual([earlier, later]);
  });
});
