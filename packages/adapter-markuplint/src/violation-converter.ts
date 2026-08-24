// Violation -> GeneratedDiagnostic (adapter-markuplint.md §6).
import type { MLResultInfo } from "markuplint";
import {
  compareGeneratedDiagnostics,
  type AdapterLogger,
  type DiagnosticSeverity,
  type GeneratedDiagnostic,
} from "@vue-html-bridge/validator-api";
import { classifyApplicability } from "./generated-profile.js";
import { buildLineStartIndex, toUtf16Range } from "./location-index.js";

type Violation = MLResultInfo["violations"][number];

const KNOWN_SEVERITIES: readonly DiagnosticSeverity[] = [
  "error",
  "warning",
  "info",
];

function toSeverity(
  severity: string,
  logger: AdapterLogger,
): DiagnosticSeverity {
  if ((KNOWN_SEVERITIES as readonly string[]).includes(severity)) {
    return severity as DiagnosticSeverity;
  }
  logger.warn("Unknown Markuplint violation severity; downgraded to warning.", {
    severity,
  });
  return "warning";
}

export function toGeneratedDiagnostics(
  html: string,
  violations: readonly Violation[],
  logger: AdapterLogger,
): readonly GeneratedDiagnostic[] {
  const lineStarts = buildLineStartIndex(html);
  const diagnostics = violations.map((violation) => ({
    ruleId: violation.ruleId,
    severity: toSeverity(violation.severity, logger),
    message: violation.message,
    range: toUtf16Range(lineStarts, violation),
    applicability: classifyApplicability(violation.ruleId),
  }));
  // validator-api.md §5: the adapter sorts diagnostics (range.start,
  // range.end, severity, ruleId, message) before returning, so the result is
  // deterministic and comparable across runs regardless of Markuplint's own
  // internal rule-execution order.
  return [...diagnostics].sort(compareGeneratedDiagnostics);
}
