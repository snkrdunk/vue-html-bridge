// Provenance-based normalization (analyzer.md §7): rewrite or suppress a
// remapped occurrence based on how core produced the generated value at its
// primary source range. Never looks at the adapter's rule ID or message
// text — only at the provenance kind and the adapter-declared applicability
// (§7 "never from the message string").
import type { RemappedOccurrence } from "./remap.js";

export interface NormalizedOccurrence {
  adapterId: string;
  variantId: string;
  variantDecisions: RemappedOccurrence["variantDecisions"];
  virtualFilename: string;
  generatedRange: RemappedOccurrence["generatedRange"];
  code: string;
  severity: RemappedOccurrence["severity"];
  message: string;
  codeDescriptionHref?: string;
  primary: RemappedOccurrence["primary"];
  related: RemappedOccurrence["related"];
  mappingFallback: boolean;
  /**
   * Set only when NOT rewritten: the adapter's own opaque dedup key for
   * this diagnostic (§8.2). Left unset after a rewrite so aggregation falls
   * back to the (now-deterministic) rewritten message for grouping.
   */
  fingerprint?: string;
  /** The raw ruleId/message this entry was rewritten from, if it was. */
  originalRuleId?: string;
  originalMessage?: string;
}

/** Returns undefined when the occurrence should be suppressed entirely. */
export function normalizeOccurrence(
  occurrence: RemappedOccurrence,
): NormalizedOccurrence | undefined {
  const code = occurrence.ruleId ?? "unknown-rule";
  const provenance = occurrence.primaryProvenance;

  if (
    provenance?.kind === "synthetic" &&
    occurrence.applicability === "source-representation"
  ) {
    return undefined;
  }

  if (
    provenance?.kind === "sentinel" &&
    occurrence.uniquelyContained &&
    occurrence.generatedRange
  ) {
    return {
      adapterId: occurrence.adapterId,
      variantId: occurrence.variantId,
      variantDecisions: occurrence.variantDecisions,
      virtualFilename: occurrence.virtualFilename,
      generatedRange: occurrence.generatedRange,
      code: sentinelBridgeCode(provenance.reason),
      severity: occurrence.severity,
      message: sentinelMessage(provenance),
      primary: provenance.sourceRange,
      related: occurrence.related,
      mappingFallback: occurrence.mappingFallback,
      originalRuleId: occurrence.ruleId,
      originalMessage: occurrence.message,
    };
  }

  return {
    adapterId: occurrence.adapterId,
    variantId: occurrence.variantId,
    variantDecisions: occurrence.variantDecisions,
    virtualFilename: occurrence.virtualFilename,
    generatedRange: occurrence.generatedRange,
    code,
    severity: occurrence.severity,
    message: occurrence.mappingFallback
      ? `${occurrence.message} (could not be traced back to specific source syntax)`
      : occurrence.message,
    codeDescriptionHref: occurrence.codeDescriptionHref,
    primary: occurrence.primary,
    related: occurrence.related,
    mappingFallback: occurrence.mappingFallback,
    fingerprint: occurrence.fingerprint,
  };
}

function sentinelBridgeCode(
  reason: "non-finite-type" | "unresolved-expression",
): string {
  return reason === "non-finite-type"
    ? "vue-html-bridge/non-finite-attribute-value"
    : "vue-html-bridge/unresolved-expression-value";
}

function sentinelMessage(provenance: {
  reason: "non-finite-type" | "unresolved-expression";
  originalType?: string;
}): string {
  const type = provenance.originalType
    ? ` (type: ${provenance.originalType})`
    : "";
  return provenance.reason === "non-finite-type"
    ? `Cannot narrow this value to a finite set${type}. Use a literal union so the bridge can validate the real values.`
    : `This expression could not be resolved to a literal at analysis time${type}; a placeholder value was validated instead of the real one.`;
}
