// UTF-16 offset <-> LSP Position conversion (language-server.md §5).
// Phase 1 is UTF-16-only (ADR-0004); vscode-languageserver-textdocument's
// TextDocument.positionAt/offsetAt are already UTF-16-code-unit based and
// already clamp out-of-range offsets, so no separate PositionIndex is
// needed yet. A real PositionIndex abstraction (for UTF-8/UTF-32) is added
// in Phase 2 Track 3, alongside the spike prototype in
// spikes/s3-utf16-lsp/position-index.ts.
import type { Range } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { SourceRange } from "@vue-html-bridge/analyzer";

export function toLspRange(
  document: TextDocument,
  sourceRange: SourceRange,
): Range {
  return {
    start: document.positionAt(sourceRange.start),
    end: document.positionAt(sourceRange.end),
  };
}
