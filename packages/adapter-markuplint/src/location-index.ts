// UTF-16 line/col -> absolute-offset conversion (adapter-markuplint.md §6.1,
// pinned by the Phase 0 spike against real Markuplint output: line/col are
// 1-based, the unit is UTF-16 code units, and there is no explicit `end` —
// it is `start + raw.length`).
import type { GeneratedRange } from "@vue-html-bridge/validator-api";

export interface LocatableViolation {
  readonly line: number;
  readonly col: number;
  readonly raw: string;
}

/** Builds a line-start offset index once per `html` string. */
export function buildLineStartIndex(html: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < html.length; i += 1) {
    if (html[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function toOffset(
  lineStarts: readonly number[],
  line: number,
  col: number,
): number {
  const lineStart = lineStarts[line - 1];
  if (lineStart === undefined) {
    throw new Error(
      `line ${line} out of range (have ${lineStarts.length} lines)`,
    );
  }
  return lineStart + (col - 1);
}

/**
 * `raw: ""` marks a violation with no locatable position (e.g. a
 * `config-error`) — this must never be widened into a real `(1,1)` range.
 */
export function toUtf16Range(
  lineStarts: readonly number[],
  violation: LocatableViolation,
): GeneratedRange | undefined {
  if (violation.raw === "") return undefined;
  const start = toOffset(lineStarts, violation.line, violation.col);
  return { start, end: start + violation.raw.length };
}
