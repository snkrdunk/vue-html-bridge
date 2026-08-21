import {
  VALIDATOR_API_VERSION,
  type HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";

export function createNoBlinkAdapter(): HtmlValidatorAdapter<
  Record<string, never>
> {
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
    async createSession() {
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
