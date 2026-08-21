// Violation -> GeneratedDiagnostic (adapter-markuplint.md §6).
import type { MLResultInfo } from "markuplint";
import type {
  AdapterLogger,
  DiagnosticSeverity,
  GeneratedDiagnostic,
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
  return violations.map((violation) => ({
    ruleId: violation.ruleId,
    severity: toSeverity(violation.severity, logger),
    message: violation.message,
    range: toUtf16Range(lineStarts, violation),
    applicability: classifyApplicability(violation.ruleId),
  }));
}
