// cli.md §9 item 10: exit-code table and `--fail-on` threshold interactions.
import { describe, expect, it } from "vitest";
import {
  computeExitCode,
  EXIT_RUN_ERROR,
  EXIT_SUCCESS,
  EXIT_THRESHOLD,
  severityMeetsThreshold,
  type FailOnThreshold,
} from "./exit-codes.js";

describe("severityMeetsThreshold (cli.md §8 --fail-on)", () => {
  const severities = ["error", "warning", "info", "hint"] as const;

  it.each(["error", "warning", "info", "hint"] as const)(
    "threshold %s: only severities at or above it count",
    (threshold: FailOnThreshold) => {
      const rank: Record<string, number> = {
        error: 0,
        warning: 1,
        info: 2,
        hint: 3,
      };
      for (const severity of severities) {
        expect(severityMeetsThreshold(severity, threshold)).toBe(
          rank[severity]! <= rank[threshold]!,
        );
      }
    },
  );

  it('"never" never meets the threshold, for any severity', () => {
    for (const severity of severities) {
      expect(severityMeetsThreshold(severity, "never")).toBe(false);
    }
  });
});

describe("computeExitCode (cli.md §8 table, precedence signal > 2 > 1 > 0)", () => {
  it("clean run: 0", () => {
    expect(
      computeExitCode({
        hasRunLevelError: false,
        hasThresholdDiagnostic: false,
      }),
    ).toBe(EXIT_SUCCESS);
  });

  it("threshold diagnostic only: 1", () => {
    expect(
      computeExitCode({
        hasRunLevelError: false,
        hasThresholdDiagnostic: true,
      }),
    ).toBe(EXIT_THRESHOLD);
  });

  it("run-level error dominates a threshold diagnostic: 2", () => {
    expect(
      computeExitCode({ hasRunLevelError: true, hasThresholdDiagnostic: true }),
    ).toBe(EXIT_RUN_ERROR);
  });

  it("run-level error alone: 2", () => {
    expect(
      computeExitCode({
        hasRunLevelError: true,
        hasThresholdDiagnostic: false,
      }),
    ).toBe(EXIT_RUN_ERROR);
  });

  it("a signal code always wins, even over a run-level error", () => {
    expect(
      computeExitCode({
        signalExitCode: 130,
        hasRunLevelError: true,
        hasThresholdDiagnostic: true,
      }),
    ).toBe(130);
  });
});
