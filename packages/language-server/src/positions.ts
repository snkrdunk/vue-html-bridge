// UTF-16/UTF-8/UTF-32 offset <-> LSP Position conversion (language-server.md
// §5). Phase 1 shipped UTF-16-only (ADR-0004); this is the real PositionIndex
// promoted from the Phase 0 prototype (spikes/s3-utf16-lsp/position-index.ts)
// for Phase 2 Track 3, with encoding negotiated per client capabilities.
import {
  PositionEncodingKind,
  type Position,
  type Range,
} from "vscode-languageserver/node";
import type { SourceRange } from "@vue-html-bridge/analyzer";

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
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function utf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export interface PositionIndex {
  offsetToPosition(offset: number, encoding: PositionEncodingKind): Position;
  positionToOffset(position: Position, encoding: PositionEncodingKind): number;
}

/**
 * Builds a line index once per document version/snapshot, then answers
 * offset<->Position queries in O(log lines) + O(line length) for the
 * character-unit conversion within a line.
 *
 * Before clamping an offset to [0, text.length], an out-of-range offset is
 * logged by the caller (server.ts) — this class itself throws, since silently
 * clamping would hide an upstream bug (§5).
 */
export function createPositionIndex(text: string): PositionIndex {
  const lines: LineEntry[] = [];
  let utf16 = 0;
  let lineStartUtf16 = 0;

  const pushLine = (endUtf16: number) => {
    lines.push({ startUtf16: lineStartUtf16, endUtf16 });
  };

  while (utf16 < text.length) {
    const code = text.charCodeAt(utf16);
    if (code === 0x0d /* \r */) {
      const next = text.charCodeAt(utf16 + 1);
      const terminatorLength = next === 0x0a /* \n */ ? 2 : 1;
      pushLine(utf16);
      utf16 += terminatorLength;
      lineStartUtf16 = utf16;
      continue;
    }
    if (code === 0x0a /* \n */) {
      pushLine(utf16);
      utf16 += 1;
      lineStartUtf16 = utf16;
      continue;
    }
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(utf16 + 1))) {
      utf16 += 2;
      continue;
    }
    utf16 += 1;
  }
  // Final (possibly empty) line, with no terminator.
  pushLine(utf16);

  function findLineIndex(utf16Offset: number): number {
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

  function characterFromUtf16(
    lineStart: number,
    targetUtf16: number,
    encoding: PositionEncodingKind,
  ): number {
    if (encoding === PositionEncodingKind.UTF16) {
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
          throw new MidSurrogatePairError(targetUtf16);
        }
        const codePoint = text.codePointAt(cursor)!;
        cursor += 2;
        charCount +=
          encoding === PositionEncodingKind.UTF8
            ? utf8ByteLengthForCodePoint(codePoint)
            : 1;
      } else {
        cursor += 1;
        charCount +=
          encoding === PositionEncodingKind.UTF8
            ? utf8ByteLengthForCodePoint(code)
            : 1;
      }
    }
    return charCount;
  }

  function offsetToPosition(
    offset: number,
    encoding: PositionEncodingKind,
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
    return {
      line: lineIndex,
      character: characterFromUtf16(line.startUtf16, offset, encoding),
    };
  }

  function positionToOffset(
    position: Position,
    encoding: PositionEncodingKind,
  ): number {
    const line = lines[position.line];
    if (!line) {
      throw new RangeError(`line ${position.line} out of range`);
    }
    if (encoding === PositionEncodingKind.UTF16) {
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
          encoding === PositionEncodingKind.UTF8
            ? utf8ByteLengthForCodePoint(codePoint)
            : 1;
        if (unitsConsumed + width > position.character) {
          throw new MidSurrogatePairError(cursor);
        }
        cursor += 2;
        unitsConsumed += width;
      } else {
        const width =
          encoding === PositionEncodingKind.UTF8
            ? utf8ByteLengthForCodePoint(code)
            : 1;
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

/**
 * §5 step 1-2: UTF-16 whenever the client offers it or sends no capability
 * at all (the LSP-mandated fallback, and what the highest-share clients do);
 * otherwise a client-declared preference for UTF-8/UTF-32.
 */
export function negotiatePositionEncoding(
  offered: readonly string[] | undefined,
): PositionEncodingKind {
  if (!offered || offered.length === 0) return PositionEncodingKind.UTF16;
  if (offered.includes(PositionEncodingKind.UTF16)) {
    return PositionEncodingKind.UTF16;
  }
  if (offered.includes(PositionEncodingKind.UTF8)) {
    return PositionEncodingKind.UTF8;
  }
  if (offered.includes(PositionEncodingKind.UTF32)) {
    return PositionEncodingKind.UTF32;
  }
  return PositionEncodingKind.UTF16;
}

export function toLspRange(
  index: PositionIndex,
  encoding: PositionEncodingKind,
  sourceRange: SourceRange,
): Range {
  return {
    start: index.offsetToPosition(sourceRange.start, encoding),
    end: index.offsetToPosition(sourceRange.end, encoding),
  };
}

export function toSourceOffset(
  index: PositionIndex,
  encoding: PositionEncodingKind,
  position: Position,
): number {
  return index.positionToOffset(position, encoding);
}
