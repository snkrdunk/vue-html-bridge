import { describe, expect, it } from "vitest";
import {
  AdapterSessionFailureError,
  checkHtmlValidatorAdapter,
  compareGeneratedDiagnostics,
  isAdapterSessionFailure,
  isValidateHtmlResult,
  VALIDATOR_API_VERSION,
  type HtmlValidatorAdapter,
} from "./index.js";

function adapter(): HtmlValidatorAdapter {
  return {
    apiVersion: VALIDATOR_API_VERSION,
    id: "fixture",
    displayName: "Fixture",
    capabilities: {
      execution: "in-process",
      supportsCancellation: true,
      supportsConfigFiles: false,
      fragmentHandling: "native",
      maxConcurrentValidations: 2,
    },
    async createSession() {
      return {
        async validate() {
          return { diagnostics: [], failures: [] };
        },
        async dispose() {},
      };
    },
  };
}

describe("validator-api runtime boundary", () => {
  it("accepts a complete adapter and distinguishes version mismatches", () => {
    expect(checkHtmlValidatorAdapter(adapter())).toMatchObject({ ok: true });
    expect(
      checkHtmlValidatorAdapter({ ...adapter(), apiVersion: 2 }),
    ).toMatchObject({ ok: false, kind: "api-version-mismatch" });
    expect(checkHtmlValidatorAdapter({})).toMatchObject({
      ok: false,
      kind: "api-version-mismatch",
    });
  });

  it("recognizes structured session failures", () => {
    const error = new AdapterSessionFailureError({
      code: "configuration-error",
      message: "bad config",
      recoverable: true,
    });
    expect(isAdapterSessionFailure(error)).toBe(true);
    expect(JSON.parse(JSON.stringify(error.failure))).toEqual(error.failure);
  });

  it("validates and orders normalized results deterministically", () => {
    const result = {
      diagnostics: [
        { severity: "warning" as const, message: "later" },
        {
          severity: "error" as const,
          message: "first",
          range: { start: 1, end: 2 },
        },
      ],
      failures: [],
      metadata: { count: 2 },
    };
    expect(isValidateHtmlResult(result)).toBe(true);
    expect(
      [...result.diagnostics].sort(compareGeneratedDiagnostics)[0]?.message,
    ).toBe("first");
  });
});
