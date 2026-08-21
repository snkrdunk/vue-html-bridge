// Reverse mapping (analyzer.md §6) from a validator's generated-HTML range
// back to the SFC, and construction of the resulting SourceDiagnostic.
import { createHash } from "node:crypto";
import {
  findSourceOrigins,
  type MappingEntry,
  type SourceRange,
} from "vue-html-bridge";
import type { GeneratedDiagnostic } from "@vue-html-bridge/validator-api";
import type {
  DiagnosticEvidence,
  SourceDiagnostic,
  SourceRelatedInformation,
} from "./types.js";

const KIND_PRIORITY: Record<MappingEntry["kind"], number> = {
  "attribute-value": 0,
  "attribute-name": 1,
  "element-name": 2,
  text: 3,
};

const MAX_RELATED_INFORMATION = 8;
const MAX_EVIDENCE_VARIANTS = 5;

export interface RemapContext {
  adapterId: string;
  map: readonly MappingEntry[];
  templateFallback: SourceRange;
  html: string;
  virtualFilename: string;
  memberVariantIds: readonly string[];
  representativeDecisions: SourceDiagnostic["evidence"]["exampleDecisions"];
}

function locateSourceRanges(
  diagnostic: GeneratedDiagnostic,
  context: RemapContext,
): {
  primary: SourceRange;
  related: readonly SourceRelatedInformation[];
  mappingFallback: boolean;
} {
  if (!diagnostic.range) {
    return {
      primary: context.templateFallback,
      related: [],
      mappingFallback: true,
    };
  }
  const origins = findSourceOrigins(context.map, diagnostic.range);
  if (origins.length === 0) {
    return {
      primary: context.templateFallback,
      related: [],
      mappingFallback: true,
    };
  }
  const ordered = [...origins].sort((a, b) => {
    const kindDelta = KIND_PRIORITY[a.entry.kind] - KIND_PRIORITY[b.entry.kind];
    if (kindDelta !== 0) return kindDelta;
    const lengthDelta =
      a.entry.source.end -
      a.entry.source.start -
      (b.entry.source.end - b.entry.source.start);
    if (lengthDelta !== 0) return lengthDelta;
    return a.entry.source.start - b.entry.source.start;
  });
  const [first, ...rest] = ordered;
  return {
    primary: first!.entry.source,
    related: rest.map((origin) => ({
      sourceRange: origin.entry.source,
      message: "Also affects this location.",
    })),
    mappingFallback: false,
  };
}

export function remapDiagnostic(
  diagnostic: GeneratedDiagnostic,
  context: RemapContext,
): SourceDiagnostic {
  const { primary, related, mappingFallback } = locateSourceRanges(
    diagnostic,
    context,
  );
  const message = mappingFallback
    ? `${diagnostic.message} (could not be traced back to specific source syntax)`
    : diagnostic.message;
  const evidence: DiagnosticEvidence = {
    variantCount: context.memberVariantIds.length,
    variantIds: context.memberVariantIds.slice(0, MAX_EVIDENCE_VARIANTS),
    exampleDecisions: context.representativeDecisions,
    generatedExample: {
      virtualFilename: context.virtualFilename,
      range: diagnostic.range,
    },
    truncated: context.memberVariantIds.length > MAX_EVIDENCE_VARIANTS,
    mappingFallback: mappingFallback || undefined,
  };
  const code = diagnostic.ruleId ?? "unknown-rule";
  return {
    id: diagnosticId({
      origin: "validator",
      adapterId: context.adapterId,
      code,
      sourceRange: primary,
    }),
    origin: "validator",
    sourceRange: primary,
    relatedInformation: related.slice(0, MAX_RELATED_INFORMATION),
    severity: diagnostic.severity,
    message,
    code,
    adapterId: context.adapterId,
    codeDescriptionHref: diagnostic.codeDescriptionHref,
    evidence,
  };
}

export function diagnosticId(parts: {
  origin: string;
  adapterId?: string;
  code: string;
  sourceRange: SourceRange;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        parts.origin,
        parts.adapterId ?? "",
        parts.code,
        parts.sourceRange.filename,
        parts.sourceRange.start,
        parts.sourceRange.end,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}
