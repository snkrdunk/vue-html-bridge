// cli.md §9 item 6: text output golden, including related information,
// stderr run-level errors, and the summary line. This is a unit-level
// golden against the renderer's own inputs (CliDiagnostic/RunLevelError/
// RunSummaryCounts) — output/ndjson.test.ts and cli.e2e.test.ts cover the
// same content produced by a real analyzer run.
import { describe, expect, it } from "vitest";
import type { CliDiagnostic } from "../types.js";
import { createTextRenderer } from "./text.js";

function makeDiagnostic(overrides: Partial<CliDiagnostic> = {}): CliDiagnostic {
  return {
    severity: "error",
    code: "vue-html-bridge/non-finite-attribute-value",
    message:
      "Cannot narrow this attribute value to a finite set. Use a literal union allowed for aria-pressed (current type: string).",
    origin: "validator",
    adapterId: "markuplint",
    range: { start: 100, end: 120 },
    position: { startLine: 6, startColumn: 19, endLine: 6, endColumn: 26 },
    relatedInformation: [],
    evidence: { variantCount: 1, truncated: false },
    ...overrides,
  };
}

describe("createTextRenderer (cli.md §7.1)", () => {
  it("renders the documented example shape: diagnostic line, indented message, related information", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createTextRenderer(
      (chunk) => stdout.push(chunk),
      (chunk) => stderr.push(chunk),
    );

    renderer.start();
    renderer.file("src/components/Toggle.vue", [makeDiagnostic()]);
    renderer.file("src/components/Menu.vue", [
      makeDiagnostic({
        severity: "warning",
        code: "invalid-attr",
        message: "The id referenced by aria-controls does not exist.",
        position: { startLine: 5, startColumn: 11, endLine: 5, endColumn: 30 },
        evidence: { variantCount: 2, truncated: false },
        relatedInformation: [
          {
            path: "src/components/Menu.vue",
            range: { start: 200, end: 210 },
            position: {
              startLine: 8,
              startColumn: 24,
              endLine: 8,
              endColumn: 34,
            },
            message: "referenced from aria-controls",
          },
        ],
      }),
    ]);
    renderer.summary({
      filesAnalyzed: 2,
      errors: 1,
      warnings: 1,
      infos: 0,
      hints: 0,
      runErrors: 0,
    });

    expect(stdout.join("")).toBe(
      [
        "src/components/Toggle.vue:6:19 error vue-html-bridge/non-finite-attribute-value",
        "  Cannot narrow this attribute value to a finite set. Use a literal union allowed for aria-pressed (current type: string). [markuplint]",
        "src/components/Menu.vue:5:11 warning invalid-attr",
        "  The id referenced by aria-controls does not exist. (2 variants) [markuplint]",
        "    related src/components/Menu.vue:8:24 referenced from aria-controls",
        "2 files analyzed: 1 error, 1 warning, 0 infos, 0 hints",
        "",
      ].join("\n"),
    );
    expect(stderr).toEqual([]);
  });

  it("a diagnostic with no adapterId omits the bracket suffix", () => {
    const stdout: string[] = [];
    const renderer = createTextRenderer(
      (chunk) => stdout.push(chunk),
      () => {},
    );
    renderer.file("A.vue", [
      makeDiagnostic({
        origin: "core",
        adapterId: undefined,
        code: "vue-html-bridge/unsupported-template-source",
      }),
    ]);
    expect(stdout.join("")).not.toContain("[");
  });

  it("a truncated diagnostic's evidence is noted", () => {
    const stdout: string[] = [];
    const renderer = createTextRenderer(
      (chunk) => stdout.push(chunk),
      () => {},
    );
    renderer.file("A.vue", [
      makeDiagnostic({ evidence: { variantCount: 12, truncated: true } }),
    ]);
    expect(stdout.join("")).toContain("(12 variants, truncated)");
  });

  it("run-level errors go to stderr, not stdout", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createTextRenderer(
      (chunk) => stdout.push(chunk),
      (chunk) => stderr.push(chunk),
    );
    renderer.runError({
      code: "adapter-load/resolution-failed",
      message: 'Could not resolve "some-package".',
      adapterId: undefined,
    });
    renderer.runError({
      code: "file-unreadable",
      message: "Permission denied.",
      path: "src/Broken.vue",
    });
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe(
      [
        'error: Could not resolve "some-package". (adapter-load/resolution-failed)',
        "error: src/Broken.vue: Permission denied. (file-unreadable)",
        "",
      ].join("\n"),
    );
  });

  it("the summary line includes run-error counts only when nonzero", () => {
    const stdoutWithRunErrors: string[] = [];
    createTextRenderer(
      (chunk) => stdoutWithRunErrors.push(chunk),
      () => {},
    ).summary({
      filesAnalyzed: 1,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      runErrors: 2,
    });
    expect(stdoutWithRunErrors.join("")).toContain("2 run errors");

    const stdoutClean: string[] = [];
    createTextRenderer(
      (chunk) => stdoutClean.push(chunk),
      () => {},
    ).summary({
      filesAnalyzed: 1,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      runErrors: 0,
    });
    expect(stdoutClean.join("")).not.toContain("run error");
  });

  it("start() writes nothing (text mode has no start-of-stream marker)", () => {
    const stdout: string[] = [];
    createTextRenderer(
      (chunk) => stdout.push(chunk),
      () => {},
    ).start();
    expect(stdout).toEqual([]);
  });

  it("with color enabled, the severity token is wrapped in ANSI codes", () => {
    const stdout: string[] = [];
    const renderer = createTextRenderer(
      (chunk) => stdout.push(chunk),
      () => {},
      { color: true },
    );
    renderer.file("A.vue", [makeDiagnostic()]);
    // eslint-disable-next-line no-control-regex -- ANSI escape detection is the point of this assertion
    expect(stdout.join("")).toMatch(/\x1b\[31merror\x1b\[0m/);
  });
});
