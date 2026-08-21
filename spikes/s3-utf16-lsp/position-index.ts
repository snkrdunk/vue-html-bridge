/**
 * Spike prototype of language-server.md §5's PositionIndex.
 * Internal offsets are UTF-16 code units (JS string indexing), half-open
 * ranges (monorepo.md §6.1). This converts to/from LSP Position under one of
 * the three PositionEncodingKind values the LSP 3.17+ spec allows.
 */

export type PositionEncoding = "utf-16" | "utf-8" | "utf-32";

export interface Position {
  line: number;
  character: number;
}

export interface PositionIndex {
  offsetToPosition(offset: number, encoding: PositionEncoding): Position;
  positionToOffset(position: Position, encoding: PositionEncoding): number;
}

export class MidSurrogatePairError extends Error {
  constructor(offset: number) {
    super(`offset ${offset} points into the middle of a UTF-16 surrogate pair`);
    this.name = "MidSurrogatePairError";
  }
}

/**
 * Thrown for an offset that lands between the \r and \n of a CRLF line
 * terminator. CRLF is treated as one indivisible line break, so this offset
 * has no defined line/character position in any encoding — it is not a
 * position any editor cursor can occupy. Core's mapping contract never emits
 * a range boundary here; this exists so the boundary layer fails loudly
 * instead of silently producing a wrong position.
 */
export class MidLineTerminatorError extends Error {
  constructor(offset: number) {
    super(`offset ${offset} points into the middle of a CRLF line terminator`);
    this.name = "MidLineTerminatorError";
  }
}

interface LineEntry {
  /** UTF-16 code-unit offset where the line starts (after the previous line's terminator). */
  startUtf16: number;
  /** UTF-16 code-unit offset where the line's terminator begins (exclusive of content). */
  endUtf16: number;
  /** UTF-8 byte offset where the line starts. */
  startUtf8: number;
  /** UTF-32 code-point offset where the line starts. */
  startUtf32: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Builds a line index once per document version, then answers
 * offset<->Position queries in O(log lines) + O(line length) for the
 * character-unit conversion within a line.
 */
export function createPositionIndex(text: string): PositionIndex {
  const lines: LineEntry[] = [];
  let utf16 = 0;
  let utf8 = 0;
  let utf32 = 0;
  let lineStartUtf16 = 0;
  let lineStartUtf8 = 0;
  let lineStartUtf32 = 0;

  const pushLine = (endUtf16: number) => {
    lines.push({
      startUtf16: lineStartUtf16,
      endUtf16,
      startUtf8: lineStartUtf8,
      startUtf32: lineStartUtf32,
    });
  };

  while (utf16 < text.length) {
    const code = text.charCodeAt(utf16);
    if (code === 0x0d /* \r */) {
      const next = text.charCodeAt(utf16 + 1);
      const terminatorLength = next === 0x0a /* \n */ ? 2 : 1;
      pushLine(utf16);
      utf16 += terminatorLength;
      utf8 += terminatorLength; // CR/LF are single-byte in UTF-8
      utf32 += terminatorLength;
      lineStartUtf16 = utf16;
      lineStartUtf8 = utf8;
      lineStartUtf32 = utf32;
      continue;
    }
    if (code === 0x0a /* \n */) {
      pushLine(utf16);
      utf16 += 1;
      utf8 += 1;
      utf32 += 1;
      lineStartUtf16 = utf16;
      lineStartUtf8 = utf8;
      lineStartUtf32 = utf32;
      continue;
    }

    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(utf16 + 1))) {
      const codePoint = text.codePointAt(utf16)!;
      utf16 += 2;
      utf8 += utf8ByteLengthForCodePoint(codePoint);
      utf32 += 1;
      continue;
    }

    utf16 += 1;
    utf8 += utf8ByteLengthForCodePoint(code);
    utf32 += 1;
  }
  // Final (possibly empty) line, with no terminator.
  pushLine(utf16);

  function utf8ByteLengthForCodePoint(codePoint: number): number {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function findLineIndex(utf16Offset: number): number {
    // Lines are sorted by startUtf16; binary search for the containing line.
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid]!.startUtf16 <= utf16Offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  function offsetToPosition(
    offset: number,
    encoding: PositionEncoding,
  ): Position {
    if (offset < 0 || offset > text.length) {
      throw new RangeError(`offset ${offset} out of range [0, ${text.length}]`);
    }
    if (
      offset > 0 &&
      text.charCodeAt(offset - 1) === 0x0d &&
      text.charCodeAt(offset) === 0x0a
    ) {
      throw new MidLineTerminatorError(offset);
    }
    const lineIndex = findLineIndex(offset);
    const line = lines[lineIndex]!;
    const character = utf16OffsetToCharacter(
      line.startUtf16,
      offset,
      encoding,
      line,
    );
    return { line: lineIndex, character };
  }

  function utf16OffsetToCharacter(
    lineStart: number,
    targetUtf16: number,
    encoding: PositionEncoding,
    line: LineEntry,
  ): number {
    if (encoding === "utf-16") {
      return targetUtf16 - lineStart;
    }
    let cursor = lineStart;
    let charCount = 0;
    while (cursor < targetUtf16) {
      const code = text.charCodeAt(cursor);
      if (
        isHighSurrogate(code) &&
        isLowSurrogate(text.charCodeAt(cursor + 1))
      ) {
        if (targetUtf16 === cursor + 1) {
          // targetUtf16 landed strictly between the two surrogate halves.
          throw new MidSurrogatePairError(targetUtf16);
        }
        const codePoint = text.codePointAt(cursor)!;
        cursor += 2;
        charCount +=
          encoding === "utf-8" ? utf8ByteLengthForCodePoint(codePoint) : 1;
      } else {
        cursor += 1;
        charCount +=
          encoding === "utf-8" ? utf8ByteLengthForCodePoint(code) : 1;
      }
    }
    void line;
    return charCount;
  }

  function positionToOffset(
    position: Position,
    encoding: PositionEncoding,
  ): number {
    const line = lines[position.line];
    if (!line) {
      throw new RangeError(`line ${position.line} out of range`);
    }
    if (encoding === "utf-16") {
      const offset = line.startUtf16 + position.character;
      if (offset > line.endUtf16) {
        throw new RangeError(
          `character ${position.character} exceeds line ${position.line} length`,
        );
      }
      return offset;
    }
    let cursor = line.startUtf16;
    let unitsConsumed = 0;
    while (cursor < line.endUtf16 && unitsConsumed < position.character) {
      const code = text.charCodeAt(cursor);
      if (
        isHighSurrogate(code) &&
        isLowSurrogate(text.charCodeAt(cursor + 1))
      ) {
        const codePoint = text.codePointAt(cursor)!;
        const width =
          encoding === "utf-8" ? utf8ByteLengthForCodePoint(codePoint) : 1;
        if (unitsConsumed + width > position.character) {
          throw new MidSurrogatePairError(cursor);
        }
        cursor += 2;
        unitsConsumed += width;
      } else {
        const width =
          encoding === "utf-8" ? utf8ByteLengthForCodePoint(code) : 1;
        cursor += 1;
        unitsConsumed += width;
      }
    }
    if (unitsConsumed !== position.character) {
      throw new RangeError(
        `character ${position.character} exceeds line ${position.line} length in ${encoding}`,
      );
    }
    return cursor;
  }

  return { offsetToPosition, positionToOffset };
}
