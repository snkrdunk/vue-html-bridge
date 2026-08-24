import { PositionEncodingKind } from "vscode-languageserver/node";
import { describe, expect, it } from "vitest";
import {
  createPositionIndex,
  MidLineTerminatorError,
  MidSurrogatePairError,
  negotiatePositionEncoding,
} from "./positions.js";

const ENCODINGS = [
  PositionEncodingKind.UTF16,
  PositionEncodingKind.UTF8,
  PositionEncodingKind.UTF32,
];

/** Round-trips every valid UTF-16 offset in `text` through offset->Position->offset. */
function assertFullRoundTrip(text: string, encoding: string) {
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
      expect(() => index.offsetToPosition(offset, encoding)).toThrow(
        MidLineTerminatorError,
      );
      continue;
    }
    if (isMidSurrogate && encoding !== PositionEncodingKind.UTF16) {
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

describe("PositionIndex round trip (language-server.md §5)", () => {
  it("round-trips plain multi-line ASCII (LF)", () => {
    const text = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    for (const encoding of ENCODINGS) assertFullRoundTrip(text, encoding);
  });

  it("treats CRLF as a single line break, distinct from bare LF", () => {
    const text = "line one\r\nline two\nline three\r\n";
    const index = createPositionIndex(text);

    expect(index.offsetToPosition(0, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 0,
    });
    expect(index.offsetToPosition(10, PositionEncodingKind.UTF16)).toEqual({
      line: 1,
      character: 0,
    });
    expect(index.offsetToPosition(19, PositionEncodingKind.UTF16)).toEqual({
      line: 2,
      character: 0,
    });

    for (const encoding of ENCODINGS) assertFullRoundTrip(text, encoding);
  });

  it("handles an emoji (surrogate pair) mid-line and at line boundaries", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);

    const midLine = `pre${emoji}post`;
    for (const encoding of ENCODINGS) assertFullRoundTrip(midLine, encoding);

    const atLineStart = `${emoji}\nnext line`;
    for (const encoding of ENCODINGS) {
      assertFullRoundTrip(atLineStart, encoding);
    }

    const atLineEnd = `prev line\n${emoji}`;
    for (const encoding of ENCODINGS) assertFullRoundTrip(atLineEnd, encoding);

    const index = createPositionIndex(midLine);
    expect(index.offsetToPosition(3, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 3,
    });
    expect(index.offsetToPosition(3, PositionEncodingKind.UTF8)).toEqual({
      line: 0,
      character: 3,
    });
    expect(index.offsetToPosition(3, PositionEncodingKind.UTF32)).toEqual({
      line: 0,
      character: 3,
    });
    expect(index.offsetToPosition(5, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 5,
    });
    expect(index.offsetToPosition(5, PositionEncodingKind.UTF8)).toEqual({
      line: 0,
      character: 7,
    });
    expect(index.offsetToPosition(5, PositionEncodingKind.UTF32)).toEqual({
      line: 0,
      character: 4,
    });
  });

  it("rejects a position that lands in the middle of a surrogate pair for utf-8/utf-32", () => {
    const emoji = "\u{1F600}";
    const text = `x${emoji}y`;
    const index = createPositionIndex(text);

    expect(index.offsetToPosition(2, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 2,
    });
    expect(() => index.offsetToPosition(2, PositionEncodingKind.UTF8)).toThrow(
      MidSurrogatePairError,
    );
    expect(() => index.offsetToPosition(2, PositionEncodingKind.UTF32)).toThrow(
      MidSurrogatePairError,
    );
  });

  it("treats a combining character sequence as separate UTF-16 code units, not a merged grapheme", () => {
    // Explicit escapes to guarantee the decomposed form ("e" + combining
    // accent, 2 UTF-16 code units) survives regardless of source-file
    // normalization — a literal "é" character risks silently precomposing
    // to a single code unit.
    const combining = "e\u0301";
    expect(combining.length).toBe(2);

    const text = `caf${combining} au lait`;
    const index = createPositionIndex(text);

    expect(index.offsetToPosition(3, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 3,
    });
    expect(index.offsetToPosition(4, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 4,
    });
    expect(index.offsetToPosition(5, PositionEncodingKind.UTF16)).toEqual({
      line: 0,
      character: 5,
    });

    for (const encoding of ENCODINGS) assertFullRoundTrip(text, encoding);
  });

  it("converts zero-width ranges validly at document start, document end, and after a surrogate pair", () => {
    const emoji = "\u{1F600}";
    const text = `${emoji}abc`;
    const index = createPositionIndex(text);

    const start = index.offsetToPosition(0, PositionEncodingKind.UTF16);
    expect(index.positionToOffset(start, PositionEncodingKind.UTF16)).toBe(0);

    const end = index.offsetToPosition(text.length, PositionEncodingKind.UTF16);
    expect(index.positionToOffset(end, PositionEncodingKind.UTF16)).toBe(
      text.length,
    );

    const afterSurrogatePair = index.offsetToPosition(
      2,
      PositionEncodingKind.UTF16,
    );
    expect(
      index.positionToOffset(afterSurrogatePair, PositionEncodingKind.UTF16),
    ).toBe(2);
    expect(
      index.positionToOffset(
        index.offsetToPosition(2, PositionEncodingKind.UTF8),
        PositionEncodingKind.UTF8,
      ),
    ).toBe(2);
    expect(
      index.positionToOffset(
        index.offsetToPosition(2, PositionEncodingKind.UTF32),
        PositionEncodingKind.UTF32,
      ),
    ).toBe(2);
  });

  it("round-trips an empty document", () => {
    for (const encoding of ENCODINGS) assertFullRoundTrip("", encoding);
  });

  it("round-trips a document with only line breaks (CRLF, LF mixed) and trailing empty line", () => {
    const text = "\r\n\n\r\n";
    for (const encoding of ENCODINGS) assertFullRoundTrip(text, encoding);
  });
});

describe("negotiatePositionEncoding (§5 steps 1-2)", () => {
  it("picks UTF-16 when the client sends no capability at all", () => {
    expect(negotiatePositionEncoding(undefined)).toBe(
      PositionEncodingKind.UTF16,
    );
    expect(negotiatePositionEncoding([])).toBe(PositionEncodingKind.UTF16);
  });

  it("picks UTF-16 whenever the client offers it, even alongside other encodings", () => {
    expect(
      negotiatePositionEncoding([
        PositionEncodingKind.UTF32,
        PositionEncodingKind.UTF16,
      ]),
    ).toBe(PositionEncodingKind.UTF16);
  });

  it("falls back to a client-declared UTF-8/UTF-32 preference when UTF-16 is not offered", () => {
    expect(negotiatePositionEncoding([PositionEncodingKind.UTF8])).toBe(
      PositionEncodingKind.UTF8,
    );
    expect(negotiatePositionEncoding([PositionEncodingKind.UTF32])).toBe(
      PositionEncodingKind.UTF32,
    );
  });
});
