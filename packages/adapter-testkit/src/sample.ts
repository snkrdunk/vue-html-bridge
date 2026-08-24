import {
  AdapterSessionFailureError,
  VALIDATOR_API_VERSION,
  type HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";

/**
 * Settings for the educational "no-blink" sample adapter (design doc §5).
 *
 * `failOnCreate` exists purely to demonstrate the failure-vs-diagnostic
 * distinction (design doc §3.5): a real validator adapter would set this
 * when, say, its config file could not be parsed. It is what
 * `createFailureSettings` in this package's own self-tests exercises.
 */
export interface NoBlinkSettings {
  readonly failOnCreate?: boolean;
}

export function createNoBlinkAdapter(): HtmlValidatorAdapter<NoBlinkSettings> {
  return {
    apiVersion: VALIDATOR_API_VERSION,
    id: "no-blink",
    displayName: "No Blink",
    capabilities: {
      execution: "in-process",
      supportsCancellation: true,
      supportsConfigFiles: false,
      fragmentHandling: "native",
      maxConcurrentValidations: 4,
    },
    async createSession({ settings }) {
      if (settings.failOnCreate) {
        // A real adapter throws AdapterSessionFailureError from createSession
        // for an environmental/configuration problem discovered up front —
        // never surfaced as a diagnostic (validator-api §3.1).
        throw new AdapterSessionFailureError({
          code: "configuration-error",
          message:
            "no-blink: simulated configuration failure (settings.failOnCreate).",
          recoverable: false,
        });
      }
      let disposed = false;
      return {
        async validate(request, signal) {
          signal.throwIfAborted();
          if (disposed) throw new Error("Session is disposed.");
          const match = /<\/?blink\b/i.exec(request.html);
          return {
            diagnostics: match
              ? [
                  {
                    ruleId: "no-blink",
                    severity: "error",
                    message: "The blink element is obsolete.",
                    range: {
                      start: match.index + (match[0].startsWith("</") ? 2 : 1),
                      end:
                        match.index + (match[0].startsWith("</") ? 2 : 1) + 5,
                    },
                  },
                ]
              : [],
            failures: [],
          };
        },
        async dispose() {
          disposed = true;
        },
      };
    },
  };
}
