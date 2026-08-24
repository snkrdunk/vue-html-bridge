// Stage 1 of the two-stage diagnostic identity (analyzer.md §8.1): a
// DiagnosticOccurrence is one validator diagnostic reattached to one member
// variant of the work item that produced it (work-deduplication.ts). Before
// reverse mapping, occurrences are deduplicated by occurrenceKey so a
// validator that reports the exact same rule/range twice in one result
// cannot double-count.
import { createHash } from "node:crypto";
import type { DecisionAssignment, MappingEntry } from "vue-html-bridge";
import type { GeneratedDiagnostic } from "@vue-html-bridge/validator-api";

export interface DiagnosticOccurrence {
  adapterId: string;
  variantId: string;
  variantDecisions: readonly DecisionAssignment[];
  virtualFilename: string;
  /** The representative variant's map (§5.1: identical HTML shares mapping). */
  map: readonly MappingEntry[];
  diagnostic: GeneratedDiagnostic;
}

export function occurrenceKey(occurrence: DiagnosticOccurrence): string {
  const { diagnostic } = occurrence;
  return stableHash({
    adapterId: occurrence.adapterId,
    variantId: occurrence.variantId,
    ruleId: diagnostic.ruleId ?? null,
    fingerprint: diagnostic.fingerprint ?? normalizeMessage(diagnostic.message),
    generatedStart: diagnostic.range?.start ?? null,
    generatedEnd: diagnostic.range?.end ?? null,
  });
}

/** Keeps the first occurrence for each distinct occurrenceKey. */
export function dedupeOccurrences(
  occurrences: readonly DiagnosticOccurrence[],
): readonly DiagnosticOccurrence[] {
  const seen = new Set<string>();
  const result: DiagnosticOccurrence[] = [];
  for (const occurrence of occurrences) {
    const key = occurrenceKey(occurrence);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(occurrence);
  }
  return result;
}

export function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

export function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value, new Set()))
    .digest("hex");
}

function stableStringify(value: unknown, seen: Set<unknown>): string {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`,
      )
      .join(",")}}`;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return '"[Unsupported]"';
  }
  return JSON.stringify(value) ?? "null";
}
