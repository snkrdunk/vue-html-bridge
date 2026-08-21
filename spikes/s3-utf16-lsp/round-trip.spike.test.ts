import { describe, expect, it } from "vitest";
import {
  createPositionIndex,
  MidLineTerminatorError,
  MidSurrogatePairError,
  type PositionEncoding,
} from "./position-index.js";

/** Round-trips every valid UTF-16 offset in `text` through offset->Position->offset. */
function assertFullRoundTrip(text: string, encoding: PositionEncoding) {
  const index = createPositionIndex(text);
  for (let offset = 0; offset <= text.length; offset++) {
    const code = text.charCodeAt(offset);
    const prevCode = text.charCodeAt(offset - 1);
    const isMidSurrogate =
      offset > 0 &&
      prevCode >= 0xd800 &&
      prevCode <= 0xdbff &&
      code >= 0xdc00 &&
      code <= 0xdfff;
    const isMidCrlf = offset > 0 && prevCode === 0x0d && code === 0x0a;
    if (isMidCrlf) {
      // Offset lands between \r and \n — not a valid position in any
      // encoding (CRLF is one indivisible line break). No round trip exists.
      expect(() => index.offsetToPosition(offset, encoding)).toThrow(
        MidLineTerminatorError,
      );
      continue;
    }
    if (isMidSurrogate && encoding !== "utf-16") {
      expect(() => index.offsetToPosition(offset, encoding)).toThrow(
        MidSurrogatePairError,
      );
      continue;
    }
    const position = index.offsetToPosition(offset, encoding);
    const roundTripped = index.positionToOffset(position, encoding);
    expect(roundTripped, `offset ${offset} (${encoding})`).toBe(offset);
  }
}

describe("PositionIndex round trip", () => {
  it("round-trips plain multi-line ASCII (LF)", () => {
    const text = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    assertFullRoundTrip(text, "utf-16");
    assertFullRoundTrip(text, "utf-8");
    assertFullRoundTrip(text, "utf-32");
  });

  it("treats CRLF as a single line break, distinct from bare LF", () => {
    const text = "line one\r\nline two\nline three\r\n";
    const index = createPositionIndex(text);

    // "line one" is 8 chars; CRLF is 2 code units; "line two" starts at 10.
    expect(index.offsetToPosition(0, "utf-16")).toEqual({
      line: 0,
      character: 0,
    });
    expect(index.offsetToPosition(10, "utf-16")).toEqual({
      line: 1,
      character: 0,
    });
    // "line two" (8) + "\n" (1) => "line three" starts at 10 + 9 = 19.
    expect(index.offsetToPosition(19, "utf-16")).toEqual({
      line: 2,
      character: 0,
    });

    assertFullRoundTrip(text, "utf-16");
    assertFullRoundTrip(text, "utf-8");
    assertFullRoundTrip(text, "utf-32");
  });

  it("handles an emoji (surrogate pair) mid-line and at line boundaries", () => {
    // "😀" = U+1F600, encoded as 2 UTF-16 units, 4 UTF-8 bytes, 1 UTF-32 code point.
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2); // sanity: JS strings are UTF-16 code units.

    const midLine = `pre${emoji}post`;
    assertFullRoundTrip(midLine, "utf-16");
    assertFullRoundTrip(midLine, "utf-8");
    assertFullRoundTrip(midLine, "utf-32");

    const atLineStart = `${emoji}\nnext line`;
    assertFullRoundTrip(atLineStart, "utf-16");
    assertFullRoundTrip(atLineStart, "utf-8");
    assertFullRoundTrip(atLineStart, "utf-32");

    const atLineEnd = `prev line\n${emoji}`;
    assertFullRoundTrip(atLineEnd, "utf-16");
    assertFullRoundTrip(atLineEnd, "utf-8");
    assertFullRoundTrip(atLineEnd, "utf-32");

    // Precise numeric check: "pre" = 3 UTF-16 units = 3 UTF-8 bytes = 3 UTF-32 code points.
    const index = createPositionIndex(midLine);
    expect(index.offsetToPosition(3, "utf-16")).toEqual({
      line: 0,
      character: 3,
    });
    expect(index.offsetToPosition(3, "utf-8")).toEqual({
      line: 0,
      character: 3,
    });
    expect(index.offsetToPosition(3, "utf-32")).toEqual({
      line: 0,
      character: 3,
    });
    // After the emoji (offset 5 in UTF-16 units): utf-16 char=5, utf-8 char=3+4=7, utf-32 char=3+1=4.
    expect(index.offsetToPosition(5, "utf-16")).toEqual({
      line: 0,
      character: 5,
    });
    expect(index.offsetToPosition(5, "utf-8")).toEqual({
      line: 0,
      character: 7,
    });
    expect(index.offsetToPosition(5, "utf-32")).toEqual({
      line: 0,
      character: 4,
    });
  });

  it("rejects a position that lands in the middle of a surrogate pair for utf-8/utf-32", () => {
    const emoji = "\u{1F600}";
    const text = `x${emoji}y`; // offsets: x=0, high-surrogate=1, low-surrogate=2, y=3
    const index = createPositionIndex(text);

    // Offset 2 (between the two surrogate halves) is a valid UTF-16 offset
    // (JS string indexing allows it) but must be rejected for utf-8/utf-32,
    // since it has no corresponding whole-code-point boundary.
    expect(index.offsetToPosition(2, "utf-16")).toEqual({
      line: 0,
      character: 2,
    });
    expect(() => index.offsetToPosition(2, "utf-8")).toThrow(
      MidSurrogatePairError,
    );
    expect(() => index.offsetToPosition(2, "utf-32")).toThrow(
      MidSurrogatePairError,
    );
  });

  it("treats a combining character sequence as separate UTF-16 code units, not a merged grapheme", () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT (decomposed "é"), vs. text using it inline.
    const combining = "é";
    expect(combining.length).toBe(2); // two distinct UTF-16 code units.

    const text = `caf${combining} au lait`;
    const index = createPositionIndex(text);

    // LSP operates on code units, so the combining mark must be independently
    // addressable — offset 4 sits between "e" and the combining accent.
    expect(index.offsetToPosition(3, "utf-16")).toEqual({
      line: 0,
      character: 3,
    }); // just before "e"
    expect(index.offsetToPosition(4, "utf-16")).toEqual({
      line: 0,
      character: 4,
    }); // between "e" and combining accent — a valid, distinct position
    expect(index.offsetToPosition(5, "utf-16")).toEqual({
      line: 0,
      character: 5,
    }); // after the combining accent

    assertFullRoundTrip(text, "utf-16");
    assertFullRoundTrip(text, "utf-8");
    assertFullRoundTrip(text, "utf-32");
  });

  it("converts zero-width ranges validly at document start, document end, and after a surrogate pair", () => {
    const emoji = "\u{1F600}";
    const text = `${emoji}abc`;
    const index = createPositionIndex(text);

    // Start of document.
    const start = index.offsetToPosition(0, "utf-16");
    expect(index.positionToOffset(start, "utf-16")).toBe(0);

    // End of document.
    const end = index.offsetToPosition(text.length, "utf-16");
    expect(index.positionToOffset(end, "utf-16")).toBe(text.length);

    // Immediately after the surrogate pair (offset 2).
    const afterSurrogatePair = index.offsetToPosition(2, "utf-16");
    expect(index.positionToOffset(afterSurrogatePair, "utf-16")).toBe(2);
    // Same point is also valid in utf-8/utf-32 since it's a whole-code-point boundary.
    expect(
      index.positionToOffset(index.offsetToPosition(2, "utf-8"), "utf-8"),
    ).toBe(2);
    expect(
      index.positionToOffset(index.offsetToPosition(2, "utf-32"), "utf-32"),
    ).toBe(2);
  });

  it("round-trips an empty document", () => {
    assertFullRoundTrip("", "utf-16");
    assertFullRoundTrip("", "utf-8");
    assertFullRoundTrip("", "utf-32");
  });

  it("round-trips a document with only line breaks (CRLF, LF mixed) and trailing empty line", () => {
    const text = "\r\n\n\r\n";
    assertFullRoundTrip(text, "utf-16");
    assertFullRoundTrip(text, "utf-8");
    assertFullRoundTrip(text, "utf-32");
  });
});
