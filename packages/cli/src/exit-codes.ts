// The run-outcome/exit-code model (cli.md §8). Exit code precedence is
// signal > run-level error (2) > threshold hit (1) > clean (0).
export const EXIT_SUCCESS = 0;
export const EXIT_THRESHOLD = 1;
export const EXIT_RUN_ERROR = 2;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export type FailOnThreshold = "error" | "warning" | "info" | "hint" | "never";

const SEVERITY_RANK: Record<"error" | "warning" | "info" | "hint", number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/**
 * cli.md §8: the lowest severity that counts toward exit code 1, per
 * `--fail-on`. `"never"` means no diagnostic ever triggers the threshold
 * exit code (the run can still exit 2 via a run-level error, or with a
 * signal code).
 */
export function severityMeetsThreshold(
  severity: "error" | "warning" | "info" | "hint",
  threshold: FailOnThreshold,
): boolean {
  if (threshold === "never") return false;
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

/**
 * cli.md §8 exit code table, precedence signal > 2 > 1 > 0. `signalExitCode`
 * is set only when the run was interrupted (130/143); it always wins.
 */
export function computeExitCode(outcome: {
  signalExitCode?: number;
  hasRunLevelError: boolean;
  hasThresholdDiagnostic: boolean;
}): number {
  if (outcome.signalExitCode !== undefined) return outcome.signalExitCode;
  if (outcome.hasRunLevelError) return EXIT_RUN_ERROR;
  if (outcome.hasThresholdDiagnostic) return EXIT_THRESHOLD;
  return EXIT_SUCCESS;
}
