// Reverse mapping (analyzer.md §6) from a validator's generated-HTML range
// back to the SFC. Produces a RemappedOccurrence, not a final SourceDiagnostic
// yet — provenance normalization (§7) and aggregation (§8) still need to run
// first (see provenance-normalizer.ts, aggregate.ts).
import { createHash } from "node:crypto";
import {
  findSourceOrigins,
  type DecisionAssignment,
  type GeneratedRange,
  type GeneratedValueProvenance,
  type MappingEntry,
  type SourceRange,
} from "vue-html-bridge";
import type {
  DiagnosticApplicability,
  DiagnosticSeverity,
  GeneratedDiagnostic,
} from "@vue-html-bridge/validator-api";
import type { SourceRelatedInformation } from "./types.js";
import type { DiagnosticOccurrence } from "./occurrence.js";

const KIND_PRIORITY: Record<MappingEntry["kind"], number> = {
  "attribute-value": 0,
  "attribute-name": 1,
  "element-name": 2,
  text: 3,
};

export interface RemappedOccurrence {
  adapterId: string;
  variantId: string;
  variantDecisions: readonly DecisionAssignment[];
  virtualFilename: string;
  generatedRange?: GeneratedRange;
  ruleId?: string;
  severity: DiagnosticSeverity;
  message: string;
  fingerprint?: string;
  applicability?: DiagnosticApplicability;
  codeDescriptionHref?: string;
  primary: SourceRange;
  related: readonly SourceRelatedInformation[];
  mappingFallback: boolean;
  primaryProvenance?: GeneratedValueProvenance;
  /**
   * True only when exactly one mapping entry was found for this range, and
   * it fully contains it — the "resolves uniquely" and "lies inside the
   * sentinel value" conditions §7.1 requires before a sentinel rewrite.
   */
  uniquelyContained: boolean;
}

function locateSourceRanges(
  diagnostic: GeneratedDiagnostic,
  map: readonly MappingEntry[],
  templateFallback: SourceRange,
): {
  primary: SourceRange;
  related: readonly SourceRelatedInformation[];
  mappingFallback: boolean;
  primaryProvenance?: GeneratedValueProvenance;
  uniquelyContained: boolean;
} {
  if (!diagnostic.range) {
    return {
      primary: templateFallback,
      related: [],
      mappingFallback: true,
      uniquelyContained: false,
    };
  }
  const origins = findSourceOrigins(map, diagnostic.range);
  if (origins.length === 0) {
    return {
      primary: templateFallback,
      related: [],
      mappingFallback: true,
      uniquelyContained: false,
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
  const range = diagnostic.range;
  const contains =
    first!.entry.generated.start <= range.start &&
    first!.entry.generated.end >= range.end;
  return {
    primary: first!.entry.source,
    related: rest.map((origin) => ({
      sourceRange: origin.entry.source,
      message: "Also affects this location.",
    })),
    mappingFallback: false,
    primaryProvenance: first!.entry.provenance,
    uniquelyContained: origins.length === 1 && contains,
  };
}

export function remapOccurrence(
  occurrence: DiagnosticOccurrence,
  templateFallback: SourceRange,
): RemappedOccurrence {
  const { diagnostic } = occurrence;
  const located = locateSourceRanges(
    diagnostic,
    occurrence.map,
    templateFallback,
  );
  return {
    adapterId: occurrence.adapterId,
    variantId: occurrence.variantId,
    variantDecisions: occurrence.variantDecisions,
    virtualFilename: occurrence.virtualFilename,
    generatedRange: diagnostic.range,
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    message: diagnostic.message,
    fingerprint: diagnostic.fingerprint,
    applicability: diagnostic.applicability,
    codeDescriptionHref: diagnostic.codeDescriptionHref,
    ...located,
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
