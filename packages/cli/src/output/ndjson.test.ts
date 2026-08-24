// cli.md §9 item 7 (unit-level portion): CliNdjsonRecord line construction —
// every line independently parseable JSON, `meta` first, exact field
// projection. cli.e2e.test.ts covers the full three-shape goldens against a
// real WorkspaceAnalyzer.
import { describe, expect, it } from "vitest";
import type { CliDiagnostic } from "../types.js";
import {
  CLI_NDJSON_VERSION,
  createNdjsonRenderer,
  type CliNdjsonRecord,
} from "./ndjson.js";

function collect(): { lines: string[]; write: (chunk: string) => void } {
  const lines: string[] = [];
  return { lines, write: (chunk) => lines.push(chunk) };
}

function parseAll(lines: readonly string[]): CliNdjsonRecord[] {
  return lines.map((line) => {
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2); // exactly one record + trailing empty
    return JSON.parse(line) as CliNdjsonRecord;
  });
}

const SAMPLE_DIAGNOSTIC: CliDiagnostic = {
  severity: "error",
  code: "id-duplication",
  message: "Duplicate id.",
  origin: "validator",
  adapterId: "markuplint",
  range: { start: 10, end: 20 },
  position: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 21 },
  relatedInformation: [
    {
      path: "A.vue",
      range: { start: 30, end: 40 },
      position: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 11 },
      message: "also here",
    },
  ],
  evidence: { variantCount: 3, truncated: true },
};

describe("createNdjsonRenderer (cli.md §7.2)", () => {
  it("start() emits exactly {type:'meta', version: 1} as the first line", () => {
    const { lines, write } = collect();
    createNdjsonRenderer(write).start();
    const [record] = parseAll(lines);
    expect(record).toEqual({ type: "meta", version: CLI_NDJSON_VERSION });
  });

  it("file() emits a 'file' record projecting exactly the documented CliNdjsonDiagnostic fields", () => {
    const { lines, write } = collect();
    createNdjsonRenderer(write).file("A.vue", [SAMPLE_DIAGNOSTIC]);
    const [record] = parseAll(lines);
    expect(record).toEqual({
      type: "file",
      path: "A.vue",
      diagnostics: [
        {
          severity: "error",
          code: "id-duplication",
          message: "Duplicate id.",
          origin: "validator",
          adapterId: "markuplint",
          range: { start: 10, end: 20 },
          position: {
            startLine: 1,
            startColumn: 11,
            endLine: 1,
            endColumn: 21,
          },
          relatedInformation: [
            {
              path: "A.vue",
              range: { start: 30, end: 40 },
              position: {
                startLine: 2,
                startColumn: 1,
                endLine: 2,
                endColumn: 11,
              },
              message: "also here",
            },
          ],
          evidence: { variantCount: 3, truncated: true },
        },
      ],
    });
  });

  it("file() omits adapterId/codeDescriptionHref entirely when absent, rather than emitting null", () => {
    const { lines, write } = collect();
    const coreDiagnostic: CliDiagnostic = {
      ...SAMPLE_DIAGNOSTIC,
      origin: "core",
      adapterId: undefined,
      codeDescriptionHref: undefined,
    };
    createNdjsonRenderer(write).file("A.vue", [coreDiagnostic]);
    const raw = JSON.parse(lines[0]!.trimEnd()) as Record<string, unknown>;
    const diagnostic = (raw["diagnostics"] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect("adapterId" in diagnostic).toBe(false);
    expect("codeDescriptionHref" in diagnostic).toBe(false);
  });

  it("file() never includes internal fields (id, variantIds, generatedExample, source text)", () => {
    const { lines, write } = collect();
    createNdjsonRenderer(write).file("A.vue", [SAMPLE_DIAGNOSTIC]);
    expect(lines.join("")).not.toMatch(/variantIds|generatedExample|"id":/);
  });

  it("runError() emits a 'runError' record, path/adapterId omitted when absent", () => {
    const { lines, write } = collect();
    const renderer = createNdjsonRenderer(write);
    renderer.runError({
      code: "adapter-load/resolution-failed",
      message: "boom",
    });
    renderer.runError({
      code: "file-unreadable",
      message: "denied",
      path: "A.vue",
      adapterId: "markuplint",
    });
    const [first, second] = parseAll(lines);
    expect(first).toEqual({
      type: "runError",
      code: "adapter-load/resolution-failed",
      message: "boom",
    });
    expect(second).toEqual({
      type: "runError",
      code: "file-unreadable",
      message: "denied",
      path: "A.vue",
      adapterId: "markuplint",
    });
  });

  it("summary() emits a 'summary' record with every severity count", () => {
    const { lines, write } = collect();
    createNdjsonRenderer(write).summary({
      filesAnalyzed: 5,
      errors: 1,
      warnings: 2,
      infos: 0,
      hints: 0,
      runErrors: 1,
    });
    const [record] = parseAll(lines);
    expect(record).toEqual({
      type: "summary",
      filesAnalyzed: 5,
      errors: 1,
      warnings: 2,
      infos: 0,
      hints: 0,
      runErrors: 1,
    });
  });

  it("writes are flushed per call (streaming), not batched into one JSON document", () => {
    const writes: string[] = [];
    const renderer = createNdjsonRenderer((chunk) => writes.push(chunk));
    renderer.start();
    renderer.file("A.vue", []);
    renderer.file("B.vue", []);
    expect(writes).toHaveLength(3);
    for (const chunk of writes) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });
});
