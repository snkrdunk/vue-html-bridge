// Spike S2 criterion 4 (adapter-markuplint.md §3.1 item 4, §6.1): pin down the
// unit/base/end semantics of a Markuplint `Violation`'s line/col/raw.
//
// Findings (see FINDINGS.md for the full writeup):
// - `line` and `col` are both 1-based.
// - The unit is UTF-16 code units — confirmed empirically below with an emoji
//   (a surrogate pair, 2 UTF-16 units / 1 code point) and a combining mark
//   (2 separate UTF-16 units): the reported `col` matches JS `string.length`-style
//   indexing, not Unicode code-point or grapheme-cluster counting.
// - There is no explicit `end`/`endOffset` on the public `Violation` type — only
//   `raw` (the exact matched substring). The end offset must be derived as
//   `start + raw.length` (in UTF-16 code units). `raw` can itself span multiple
//   lines (an element's opening tag broken across lines); that doesn't complicate
//   the math because once `start` is an absolute offset, `end = start + raw.length`
//   regardless of embedded newlines.
// - A violation with no locatable position (e.g. `config-error`) reports
//   `raw: ""`, `line: 1`, `col: 1` — the adapter must treat empty `raw` as the
//   "no usable range" case (adapter-markuplint.md §6.1: "if nothing is available,
//   we use a zero-width range or undefined"), not a real one-column range at (1,1).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MLEngine } from "markuplint";
import type { MLResultInfo } from "markuplint";
import { describe, expect, it } from "vitest";

type Violation = MLResultInfo["violations"][number];

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(here, "fixtures/bridge-config.json");

/** Prototype of the UTF-16 line-start index described in adapter-markuplint.md §6.1. */
function buildLineStartIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** `line`/`col` are 1-based; this returns a 0-based UTF-16 absolute offset. */
function toOffset(lineStarts: number[], line: number, col: number): number {
  const lineStart = lineStarts[line - 1];
  if (lineStart === undefined) {
    throw new Error(
      `line ${line} out of range (have ${lineStarts.length} lines)`,
    );
  }
  return lineStart + (col - 1);
}

function toUtf16Range(
  html: string,
  violation: Pick<Violation, "line" | "col" | "raw">,
): { start: number; end: number } | undefined {
  if (violation.raw === "") return undefined; // no locatable position
  const lineStarts = buildLineStartIndex(html);
  const start = toOffset(lineStarts, violation.line, violation.col);
  const end = start + violation.raw.length;
  return { start, end };
}

async function firstMatchingViolation(
  html: string,
  ruleId: string,
): Promise<Violation> {
  const engine = await MLEngine.fromCode(html, {
    name: "/tmp/x/y.__vue_html_bridge__/variant-loc.html",
    configFile,
    noSearchConfig: true,
  });
  const result = await engine.exec();
  await engine.close();
  const violation = result?.violations.find((v) => v.ruleId === ruleId);
  if (!violation) {
    throw new Error(
      `expected a "${ruleId}" violation, got: ${JSON.stringify(result?.violations)}`,
    );
  }
  return violation;
}

describe("S2 criterion 4: violation line/col/raw semantics", () => {
  it("line/col are 1-based, and CRLF counts as a single line break", async () => {
    const html = '<p>ok</p>\r\n<img src="a.png">';
    const violation = await firstMatchingViolation(html, "required-attr");
    expect(violation.line).toBe(2);
    expect(violation.col).toBe(1);
    const range = toUtf16Range(html, violation);
    expect(range).toBeDefined();
    expect(html.slice(range!.start, range!.end)).toBe(violation.raw);
  });

  it("col counts UTF-16 code units across an emoji surrogate pair, not Unicode code points", async () => {
    const html = '<p>\u{1F600}<img src="a.png"></p>'; // "<p>" + 😀 (2 UTF-16 units) + "<img..."
    const violation = await firstMatchingViolation(html, "required-attr");
    expect(violation.line).toBe(1);
    // "<p>" = 3 code units (cols 1-3), emoji = 2 code units (cols 4-5), "<img" starts at col 6.
    // If Markuplint counted Unicode code points instead, this would be col 5.
    expect(violation.col).toBe(6);
    const range = toUtf16Range(html, violation);
    expect(html.slice(range!.start, range!.end)).toBe(violation.raw);
  });

  it("col counts a combining mark as its own UTF-16 code unit (not 1 grapheme)", async () => {
    const html = 'é<img src="a.png">'; // "e" + COMBINING ACUTE ACCENT (2 code units) + "<img..."
    const violation = await firstMatchingViolation(html, "required-attr");
    expect(violation.col).toBe(3);
    const range = toUtf16Range(html, violation);
    expect(html.slice(range!.start, range!.end)).toBe(violation.raw);
  });

  it("raw can span multiple lines; start + raw.length (not line-relative math) still yields the correct end", async () => {
    const html = '<img\n  src="a.png"\n>';
    const violation = await firstMatchingViolation(html, "required-attr");
    expect(violation.raw).toBe(html); // the whole multi-line opening tag
    const range = toUtf16Range(html, violation);
    expect(range).toEqual({ start: 0, end: html.length });
    expect(html.slice(range!.start, range!.end)).toBe(violation.raw);
  });

  it('a violation with no locatable position reports raw: "" and must be treated as no-range, not (1,1)', async () => {
    // An invalid configFile path (relative, not absolute) is the simplest reliable way
    // to force markuplint's own `config-error` violation, which has no real position.
    const engine = await MLEngine.fromCode("<p>ok</p>", {
      name: "/tmp/x/y.__vue_html_bridge__/variant-noloc.html",
      configFile: "not-an-absolute-path.json",
      noSearchConfig: true,
    });
    const result = await engine.exec();
    await engine.close();
    const violation = result?.violations.find(
      (v) => v.ruleId === "config-error",
    );
    expect(violation).toBeDefined();
    expect(violation?.raw).toBe("");
    expect(toUtf16Range("<p>ok</p>", violation!)).toBeUndefined();
  });
});
