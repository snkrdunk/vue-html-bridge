// textDocument/hover (language-server.md §8): hit-test the cached
// SourceDiagnostic list used for the last publish, and render bridge
// explanation + validator detail as markdown.
import type { Hover, PositionEncodingKind } from "vscode-languageserver/node";
import type { SourceDiagnostic } from "@vue-html-bridge/analyzer";
import { toLspRange, type PositionIndex } from "./positions.js";

const SEVERITY_ORDER: Record<SourceDiagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/**
 * §8 hit-testing: a non-empty range matches `start <= offset < end`; a
 * zero-width range matches only `offset === start`. Ties broken by
 * severity, then shorter range, then adapterId/code.
 */
export function findHoverDiagnostic(
  diagnostics: readonly SourceDiagnostic[],
  offset: number,
): SourceDiagnostic | undefined {
  const matches = diagnostics.filter((diagnostic) => {
    const { start, end } = diagnostic.sourceRange;
    return start === end ? offset === start : start <= offset && offset < end;
  });
  if (matches.length === 0) return undefined;
  return [...matches].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.sourceRange.end -
        a.sourceRange.start -
        (b.sourceRange.end - b.sourceRange.start) ||
      (a.adapterId ?? "").localeCompare(b.adapterId ?? "") ||
      a.code.localeCompare(b.code),
  )[0];
}

export function buildHoverContent(diagnostic: SourceDiagnostic): string {
  const heading = diagnostic.adapterId
    ? `**${diagnostic.adapterId} · ${diagnostic.code}**`
    : `**${diagnostic.code}**`;
  const lines = [heading, "", diagnostic.message];

  const evidence = diagnostic.evidence;
  if (evidence.variantCount > 1) {
    const shown = evidence.variantIds.join(", ");
    const remaining = evidence.variantCount - evidence.variantIds.length;
    const more =
      evidence.truncated && remaining > 0 ? ` (+${remaining} more)` : "";
    lines.push(
      "",
      `Occurs in ${evidence.variantCount} variants: ${shown}${more}`,
    );
  }

  const original = evidence.originalValidatorMessages;
  if (original && original.length > 0) {
    const [first, ...rest] = original;
    const restNote = rest.length > 0 ? ` (+${rest.length} more)` : "";
    lines.push("", "**Validator detail**", `${first}${restNote}`);
  }

  return lines.join("\n");
}

export function buildHover(
  index: PositionIndex,
  encoding: PositionEncodingKind,
  diagnostic: SourceDiagnostic,
): Hover {
  return {
    contents: { kind: "markdown", value: buildHoverContent(diagnostic) },
    range: toLspRange(index, encoding, diagnostic.sourceRange),
  };
}
