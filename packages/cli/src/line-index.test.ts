// cli.md §9 item 8: offset -> line/column conversion at the output boundary.
// The fixture family (CRLF, emoji, zero-width ranges) mirrors
// packages/language-server/src/positions.test.ts's UTF-16 cases exactly,
// adapted from 0-based {line, character} LSP positions to 1-based
// {line, column} CLI positions.
import { describe, expect, it } from "vitest";
import type { SourceRange } from "@vue-html-bridge/analyzer";
import { createLineIndex, MidLineTerminatorError } from "./line-index.js";

function range(start: number, end: number): SourceRange {
  return { filename: "test.vue", start, end };
}

describe("createLineIndex (cli.md §7, §11)", () => {
  it("round-trips plain multi-line ASCII (LF)", () => {
    const text = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const index = createLineIndex(text);
    expect(index.toPosition(0)).toEqual({ line: 1, column: 1 });
    expect(index.toPosition(13)).toEqual({ line: 2, column: 1 });
    expect(index.toPosition(26)).toEqual({ line: 3, column: 1 });
  });

  it("treats CRLF as a single line break, distinct from bare LF", () => {
    const text = "line one\r\nline two\nline three\r\n";
    const index = createLineIndex(text);
    expect(index.toPosition(0)).toEqual({ line: 1, column: 1 });
    expect(index.toPosition(10)).toEqual({ line: 2, column: 1 });
    expect(index.toPosition(19)).toEqual({ line: 3, column: 1 });
  });

  it("rejects an offset that lands in the middle of a CRLF terminator", () => {
    const text = "a\r\nb";
    const index = createLineIndex(text);
    expect(() => index.toPosition(2)).toThrow(MidLineTerminatorError);
    // Either side of the terminator is fine.
    expect(index.toPosition(1)).toEqual({ line: 1, column: 2 });
    expect(index.toPosition(3)).toEqual({ line: 2, column: 1 });
  });

  it("counts an emoji (surrogate pair) as two UTF-16 columns, mid-line and at line boundaries", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);

    const midLine = `pre${emoji}post`;
    const index = createLineIndex(midLine);
    expect(index.toPosition(3)).toEqual({ line: 1, column: 4 }); // just before the emoji
    expect(index.toPosition(5)).toEqual({ line: 1, column: 6 }); // just after (2 UTF-16 units later)

    const atLineStart = createLineIndex(`${emoji}\nnext line`);
    expect(atLineStart.toPosition(0)).toEqual({ line: 1, column: 1 });
    expect(atLineStart.toPosition(2)).toEqual({ line: 1, column: 3 }); // the \n right after the emoji
    expect(atLineStart.toPosition(3)).toEqual({ line: 2, column: 1 });
  });

  it("converts zero-width ranges validly at document start, document end, and after a surrogate pair", () => {
    const emoji = "\u{1F600}";
    const text = `${emoji}abc`;
    const index = createLineIndex(text);

    expect(index.toRangePosition(range(0, 0))).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    });
    expect(index.toRangePosition(range(text.length, text.length))).toEqual({
      startLine: 1,
      startColumn: text.length + 1,
      endLine: 1,
      endColumn: text.length + 1,
    });
    expect(index.toRangePosition(range(2, 2))).toEqual({
      startLine: 1,
      startColumn: 3,
      endLine: 1,
      endColumn: 3,
    });
  });

  it("round-trips an empty document", () => {
    const index = createLineIndex("");
    expect(index.toPosition(0)).toEqual({ line: 1, column: 1 });
  });

  it("round-trips a document with only line breaks (CRLF, LF mixed) and a trailing empty line", () => {
    const text = "\r\n\n\r\n";
    const index = createLineIndex(text);
    expect(index.toPosition(0)).toEqual({ line: 1, column: 1 });
    expect(index.toPosition(2)).toEqual({ line: 2, column: 1 });
    expect(index.toPosition(3)).toEqual({ line: 3, column: 1 });
    expect(index.toPosition(5)).toEqual({ line: 4, column: 1 });
  });

  it("rejects an out-of-range offset", () => {
    const index = createLineIndex("abc");
    expect(() => index.toPosition(-1)).toThrow(RangeError);
    expect(() => index.toPosition(4)).toThrow(RangeError);
  });

  it("toRangePosition maps a real multi-line range end-to-end", () => {
    const text = "line one\nline two with a target\nline three";
    const index = createLineIndex(text);
    const targetStart = text.indexOf("target");
    const targetEnd = targetStart + "target".length;
    const position = index.toRangePosition(range(targetStart, targetEnd));
    expect(position.startLine).toBe(2);
    expect(
      text.split("\n")[position.startLine - 1]!.slice(position.startColumn - 1),
    ).toMatch(/^target/);
    expect(position.endLine).toBe(2);
  });
});
