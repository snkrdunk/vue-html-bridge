// Core diagnostics (analyzer.md §9.1) and adapter failures (§9.2) as SourceDiagnostics.
import type { CoreDiagnostic, SourceRange } from "vue-html-bridge";
import type { AdapterFailure } from "@vue-html-bridge/validator-api";
import { diagnosticId } from "./remap.js";
import type { SourceDiagnostic } from "./types.js";

const emptyEvidence: SourceDiagnostic["evidence"] = {
  variantCount: 0,
  variantIds: [],
  exampleDecisions: [],
  truncated: false,
};

/** Entries with the same code + sourceRange are merged into one (§9.1). */
export function coreDiagnosticsToSource(
  diagnostics: readonly CoreDiagnostic[],
): readonly SourceDiagnostic[] {
  const byKey = new Map<string, SourceDiagnostic>();
  for (const diagnostic of diagnostics) {
    const code = `vue-html-bridge/${diagnostic.code}`;
    const key = `${code}:${diagnostic.sourceRange.filename}:${diagnostic.sourceRange.start}:${diagnostic.sourceRange.end}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id: diagnosticId({
        origin: "core",
        code,
        sourceRange: diagnostic.sourceRange,
      }),
      origin: "core",
      sourceRange: diagnostic.sourceRange,
      relatedInformation: (diagnostic.relatedRanges ?? []).map(
        (sourceRange) => ({
          sourceRange,
          message: "Related location.",
        }),
      ),
      severity: diagnostic.severity,
      message: diagnostic.message,
      code,
      evidence: emptyEvidence,
    });
  }
  return [...byKey.values()];
}

/**
 * §9.2: `adapter/<adapter-id>/<failure-code>`, placed at the template
 * fallback range. Phase 1 does not aggregate across work items — one
 * occurrence maps to one diagnostic, same as validator diagnostics.
 */
export function adapterFailureToSource(
  adapterId: string,
  failure: AdapterFailure,
  templateFallback: SourceRange,
): SourceDiagnostic {
  const code = `adapter/${adapterId}/${failure.code}`;
  return {
    id: diagnosticId({
      origin: "adapter",
      adapterId,
      code,
      sourceRange: templateFallback,
    }),
    origin: "adapter",
    sourceRange: templateFallback,
    relatedInformation: [],
    severity: "error",
    message: failure.message,
    code,
    adapterId,
    evidence: emptyEvidence,
  };
}
