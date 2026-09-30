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
      // Never inherited from the wrapped validator rule's severity — see
      // sentinelSeverity below.
      severity: sentinelSeverity(provenance.reason),
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

/**
 * Project-wide severity convention: Error is reserved for a confirmed
 * violation of an external spec (HTML, WAI-ARIA, ...); Warning for a
 * violation of this project's own house rules/conventions; Info for
 * anything else surfaced only as information (e.g. for debugging). A
 * sentinel diagnostic can never claim Error, because the real value is by
 * definition unknown — it cannot confirm a spec violation. It resolves to
 * Warning or Info depending on *why* the value could not be resolved:
 *
 * - "non-finite-type": the bound value's type is simply too broad (e.g.
 *   `pressed: string`) to validate. The fix is a convention this project
 *   already holds elsewhere (narrow to a literal union instead of a bare
 *   `string`/`number`), so this is a house-rule violation: Warning.
 * - "unresolved-expression": core's evaluator could not symbolically
 *   evaluate the expression at all (e.g. `!item.isSold`), which is
 *   ordinary, convention-compliant code — a pure tooling limitation with no
 *   actionable violation to report: Info.
 */
function sentinelSeverity(
  reason: "non-finite-type" | "unresolved-expression",
): "warning" | "info" {
  return reason === "non-finite-type" ? "warning" : "info";
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
