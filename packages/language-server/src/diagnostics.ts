// SourceDiagnostic -> LSP Diagnostic conversion and publish ordering (§7.1, §7.2).
import {
  DiagnosticSeverity,
  type Diagnostic,
  type DiagnosticRelatedInformation,
  type PositionEncodingKind,
} from "vscode-languageserver/node";
import type {
  SourceDiagnostic,
  SourceRelatedInformation,
} from "@vue-html-bridge/analyzer";
import { toLspRange, type PositionIndex } from "./positions.js";

const SEVERITY_MAP: Record<SourceDiagnostic["severity"], DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function toLspDiagnostic(
  uri: string,
  index: PositionIndex,
  encoding: PositionEncodingKind,
  diagnostic: SourceDiagnostic,
): Diagnostic {
  return {
    range: toLspRange(index, encoding, diagnostic.sourceRange),
    severity: SEVERITY_MAP[diagnostic.severity],
    message: diagnostic.message,
    source: diagnostic.adapterId
      ? `vue-html-bridge/${diagnostic.adapterId}`
      : "vue-html-bridge",
    code: diagnostic.code,
    codeDescription: diagnostic.codeDescriptionHref
      ? { href: diagnostic.codeDescriptionHref }
      : undefined,
    relatedInformation:
      diagnostic.relatedInformation.length > 0
        ? diagnostic.relatedInformation.map((related) =>
            toLspRelatedInformation(uri, index, encoding, related),
          )
        : undefined,
    data: { diagnosticId: diagnostic.id },
  };
}

// §7.1: related information is restricted to the same URI in the initial
// version — cross-file mapping does not exist yet, so this is always safe.
function toLspRelatedInformation(
  uri: string,
  index: PositionIndex,
  encoding: PositionEncodingKind,
  related: SourceRelatedInformation,
): DiagnosticRelatedInformation {
  return {
    location: {
      uri,
      range: toLspRange(index, encoding, related.sourceRange),
    },
    message: related.message,
  };
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  [DiagnosticSeverity.Error]: 0,
  [DiagnosticSeverity.Warning]: 1,
  [DiagnosticSeverity.Information]: 2,
  [DiagnosticSeverity.Hint]: 3,
};

// Diagnostic.message is typed string | MarkupContent upstream; every
// diagnostic this server constructs always uses a plain string.
function messageText(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === "string" ? diagnostic.message : "";
}

/** §7.2: deterministic order — range, severity, source, code, message. */
export function sortLspDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character ||
      a.range.end.line - b.range.end.line ||
      a.range.end.character - b.range.end.character ||
      SEVERITY_ORDER[a.severity ?? DiagnosticSeverity.Error] -
        SEVERITY_ORDER[b.severity ?? DiagnosticSeverity.Error] ||
      (a.source ?? "").localeCompare(b.source ?? "") ||
      String(a.code ?? "").localeCompare(String(b.code ?? "")) ||
      messageText(a).localeCompare(messageText(b)),
  );
}
