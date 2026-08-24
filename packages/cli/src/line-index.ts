// Offset -> line/column conversion at the CLI's output boundary (cli.md §7,
// §11). Lines and columns are 1-based; columns count UTF-16 code units —
// since the source offsets the analyzer hands back are already UTF-16
// code-unit offsets, a column is simply `offset - lineStart`, with no
// surrogate-pair-aware unit conversion needed (unlike the language server's
// PositionIndex, which also serves UTF-8/UTF-32 LSP clients). The line-break
// and boundary-error rules mirror packages/language-server/src/positions.ts
// exactly, adapted to plain {line, column} numbers instead of LSP Position
// objects; the fixture family (CRLF, emoji, zero-width ranges) is shared
// conceptually with language-server §13.1 per cli.md §7.
import type { SourceRange } from "@vue-html-bridge/analyzer";

/**
 * Thrown for an offset that lands between the \r and \n of a CRLF line
 * terminator. CRLF is treated as one indivisible line break, so this offset
 * has no defined line/column position — core's mapping contract never emits
 * a range boundary here (see language-server/src/positions.ts); this exists
 * so the boundary layer fails loudly instead of silently producing a wrong
 * position.
 */
export class MidLineTerminatorError extends Error {
  constructor(offset: number) {
    super(`offset ${offset} points into the middle of a CRLF line terminator`);
    this.name = "MidLineTerminatorError";
  }
}

export interface LineColumn {
  /** 1-based. */
  line: number;
  /** 1-based; counts UTF-16 code units. */
  column: number;
}

export interface CliPosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface LineIndex {
  toPosition(offset: number): LineColumn;
  toRangePosition(range: SourceRange): CliPosition;
}

interface LineEntry {
  /** UTF-16 code-unit offset where the line starts (after the previous line's terminator). */
  start: number;
  /** UTF-16 code-unit offset where the line's terminator begins (exclusive of content). */
  end: number;
}

/**
 * Builds a line index once per file, then answers offset->{line,column}
 * queries in O(log lines).
 */
export function createLineIndex(text: string): LineIndex {
  const lines: LineEntry[] = [];
  let offset = 0;
  let lineStart = 0;

  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code === 0x0d /* \r */) {
      const next = text.charCodeAt(offset + 1);
      const terminatorLength = next === 0x0a /* \n */ ? 2 : 1;
      lines.push({ start: lineStart, end: offset });
      offset += terminatorLength;
      lineStart = offset;
      continue;
    }
    if (code === 0x0a /* \n */) {
      lines.push({ start: lineStart, end: offset });
      offset += 1;
      lineStart = offset;
      continue;
    }
    offset += 1;
  }
  // Final (possibly empty) line, with no terminator.
  lines.push({ start: lineStart, end: offset });

  function findLineIndex(target: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid]!.start <= target) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  function toPosition(offsetArg: number): LineColumn {
    if (offsetArg < 0 || offsetArg > text.length) {
      throw new RangeError(
        `offset ${offsetArg} out of range [0, ${text.length}]`,
      );
    }
    if (
      offsetArg > 0 &&
      text.charCodeAt(offsetArg - 1) === 0x0d &&
      text.charCodeAt(offsetArg) === 0x0a
    ) {
      throw new MidLineTerminatorError(offsetArg);
    }
    const lineIdx = findLineIndex(offsetArg);
    const line = lines[lineIdx]!;
    return { line: lineIdx + 1, column: offsetArg - line.start + 1 };
  }

  function toRangePosition(range: SourceRange): CliPosition {
    const start = toPosition(range.start);
    const end = toPosition(range.end);
    return {
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
    };
  }

  return { toPosition, toRangePosition };
}
