// Projection from the analyzer's SourceDiagnostic (UTF-16 offsets) to the
// CLI's output boundary shape (workspace-relative path already resolved by
// the caller, line/column already converted) — cli.md §7 "Projection from
// SourceDiagnostic": severity, code, message, origin, adapterId,
// codeDescriptionHref, the primary range, and relatedInformation are carried
// over; evidence is projected to variantCount + truncated only. Everything
// else (id, variant IDs, example decisions, generatedExample) is internal
// and excluded — the output never contains generated HTML or source text.
import type {
  SourceDiagnostic,
  SourceRelatedInformation,
} from "@vue-html-bridge/analyzer";
import { type LineIndex } from "./line-index.js";
import type { CliDiagnostic, CliDiagnosticRelated } from "./types.js";

/**
 * `relatedInformation` is restricted to the same file/URI in the initial
 * version (analyzer.md §6.1, mirrored by language-server's diagnostics.ts) —
 * there is no cross-file mapping yet — so every related entry uses the same
 * `filePath`/`index` as the primary diagnostic.
 */
export function projectDiagnostic(
  diagnostic: SourceDiagnostic,
  index: LineIndex,
  filePath: string,
): CliDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    origin: diagnostic.origin,
    ...(diagnostic.adapterId !== undefined
      ? { adapterId: diagnostic.adapterId }
      : {}),
    ...(diagnostic.codeDescriptionHref !== undefined
      ? { codeDescriptionHref: diagnostic.codeDescriptionHref }
      : {}),
    range: {
      start: diagnostic.sourceRange.start,
      end: diagnostic.sourceRange.end,
    },
    position: index.toRangePosition(diagnostic.sourceRange),
    relatedInformation: diagnostic.relatedInformation.map((related) =>
      projectRelated(related, index, filePath),
    ),
    evidence: {
      variantCount: diagnostic.evidence.variantCount,
      truncated: diagnostic.evidence.truncated,
    },
  };
}

function projectRelated(
  related: SourceRelatedInformation,
  index: LineIndex,
  filePath: string,
): CliDiagnosticRelated {
  return {
    path: filePath,
    range: {
      start: related.sourceRange.start,
      end: related.sourceRange.end,
    },
    position: index.toRangePosition(related.sourceRange),
    message: related.message,
  };
}

const SEVERITY_ORDER: Record<CliDiagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/** cli.md §7: "Diagnostic ordering within a file is deterministic: range, severity, origin, adapterId, code, message." */
export function sortCliDiagnostics(
  diagnostics: readonly CliDiagnostic[],
): readonly CliDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.origin.localeCompare(b.origin) ||
      (a.adapterId ?? "").localeCompare(b.adapterId ?? "") ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

/**
 * language-server.md §7.3's session-failure detection (server.ts's
 * `SESSION_FAILURE_CODE`), reused verbatim (cli.md §8): a `SourceDiagnostic`
 * with `origin: "adapter"` whose code matches this shape is a session-level
 * adapter failure that the analyzer places on *every* analyzed file. The CLI
 * reports it once at run level instead of repeating it per file.
 */
export const SESSION_FAILURE_CODE =
  /^adapter\/[^/]+\/(configuration-error|validator-unavailable)$/;

export function isSessionFailureDiagnostic(
  diagnostic: SourceDiagnostic,
): boolean {
  return (
    diagnostic.origin === "adapter" &&
    SESSION_FAILURE_CODE.test(diagnostic.code)
  );
}
