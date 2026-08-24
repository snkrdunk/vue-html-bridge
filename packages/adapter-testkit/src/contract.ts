import {
  checkHtmlValidatorAdapter,
  compareGeneratedDiagnostics,
  isAdapterSessionFailure,
  nullLogger,
  type ConfigWatchTarget,
  type DiagnosticSeverity,
  type HtmlValidatorAdapter,
  type ValidateHtmlRequest,
  type ValidateHtmlResult,
} from "@vue-html-bridge/validator-api";
import { isAbsolute, normalize } from "node:path";
import { jsonEqual, normalizeForJson } from "./assertions.js";

export interface AdapterContractFixture<TSettings> {
  adapter: HtmlValidatorAdapter<TSettings>;
  workspaceRoot: string;
  settings: TSettings;
  validHtml: string;
  invalidHtml: {
    html: string;
    expectedRuleId?: string;
    expectedSubstring: string;
    expectedSeverity?: DiagnosticSeverity;
  };
  createFailureSettings?: () => TSettings;
  expectedConfigWatchTargets?: readonly ConfigWatchTarget[];
}

export interface AdapterContractCase {
  name: string;
  run(): Promise<void>;
}

/**
 * UTF-16 boundary variants prepended to `fixture.invalidHtml.html` (design
 * doc §3.2). Each targets a distinct off-by-one class:
 * - an astral emoji is 1 code point but 2 UTF-16 code units, catching a
 *   converter that walks `Array.from(text)` or counts code points;
 * - a combining-mark sequence is 2 code points/code units but 1 rendered
 *   grapheme, catching a converter that (incorrectly) segments by grapheme;
 * - a CRLF line break exercises multi-line offset math.
 */
const UTF16_BOUNDARY_PREFIXES: readonly { label: string; prefix: string }[] = [
  {
    label: "a leading astral emoji (2 UTF-16 code units)",
    prefix: "\u{1F600}\n",
  },
  {
    label: "a leading combining-mark sequence (2 code points, 1 grapheme)",
    prefix: "é\n",
  },
  { label: "a leading CRLF line", prefix: "line one\r\n" },
];

export function createAdapterContractCases<TSettings>(
  fixture: AdapterContractFixture<TSettings>,
): readonly AdapterContractCase[] {
  const request = (html: string): ValidateHtmlRequest => ({
    html,
    documentKind: "fragment",
    sourceFilename: `${fixture.workspaceRoot}/Fixture.vue`,
    virtualFilename: `${fixture.workspaceRoot}/Fixture.vue.__vue_html_bridge__/variant-contract.html`,
  });

  const findExpectedDiagnostic = (result: ValidateHtmlResult) =>
    result.diagnostics.find(
      (item) =>
        fixture.invalidHtml.expectedRuleId === undefined ||
        item.ruleId === fixture.invalidHtml.expectedRuleId,
    );

  return [
    {
      name: "metadata passes the validator-api runtime boundary",
      async run() {
        assert(
          checkHtmlValidatorAdapter(fixture.adapter).ok,
          "invalid metadata",
        );
      },
    },
    {
      name: "valid HTML has no diagnostics or failures",
      async run() {
        const session = await createSession(fixture);
        try {
          const result = await session.validate(
            request(fixture.validHtml),
            new AbortController().signal,
          );
          assert(result.diagnostics.length === 0, "valid HTML had diagnostics");
          assert(result.failures.length === 0, "valid HTML had failures");
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "invalid HTML points at the expected UTF-16 substring",
      async run() {
        const session = await createSession(fixture);
        try {
          const result = await session.validate(
            request(fixture.invalidHtml.html),
            new AbortController().signal,
          );
          const diagnostic = findExpectedDiagnostic(result);
          assert(diagnostic, "expected diagnostic was not returned");
          assert(
            fixture.invalidHtml.expectedSeverity === undefined ||
              diagnostic.severity === fixture.invalidHtml.expectedSeverity,
            "diagnostic severity did not match",
          );
          assert(diagnostic.range, "expected diagnostic had no range");
          assert(
            fixture.invalidHtml.html
              .slice(diagnostic.range.start, diagnostic.range.end)
              .includes(fixture.invalidHtml.expectedSubstring),
            "diagnostic range did not point at the expected substring",
          );
        } finally {
          await session.dispose();
        }
      },
    },
    ...UTF16_BOUNDARY_PREFIXES.map(
      ({ label, prefix }): AdapterContractCase => ({
        name: `invalid HTML range is correct in UTF-16 code units with ${label}`,
        async run() {
          const session = await createSession(fixture);
          try {
            const html = prefix + fixture.invalidHtml.html;
            const result = await session.validate(
              request(html),
              new AbortController().signal,
            );
            const diagnostic = findExpectedDiagnostic(result);
            assert(
              diagnostic,
              `expected diagnostic was not returned with ${label} prefixed`,
            );
            assert(
              diagnostic.range,
              `expected diagnostic had no range with ${label} prefixed`,
            );
            assert(
              html
                .slice(diagnostic.range.start, diagnostic.range.end)
                .includes(fixture.invalidHtml.expectedSubstring),
              `diagnostic range did not point at the expected substring with ${label} prefixed ` +
                "(a common cause: counting code points/graphemes instead of UTF-16 code units)",
            );
          } finally {
            await session.dispose();
          }
        },
      }),
    ),
    {
      name: "multiple diagnostics follow the contracted order (range, rule, message)",
      async run() {
        const session = await createSession(fixture);
        try {
          const html = fixture.invalidHtml.html.repeat(2);
          const result = await session.validate(
            request(html),
            new AbortController().signal,
          );
          // Not every fixture's invalid HTML necessarily doubles into two
          // diagnostics (e.g. a rule that only fires once per document);
          // the ordering invariant only has something to check once there
          // are 2+ diagnostics to order.
          if (result.diagnostics.length < 2) return;
          const sorted = [...result.diagnostics].sort(
            compareGeneratedDiagnostics,
          );
          assert(
            jsonEqual(result.diagnostics, sorted),
            "diagnostics were not sorted by range, then rule, then message",
          );
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "validating the same request twice produces deep-equal results",
      async run() {
        const session = await createSession(fixture);
        try {
          const input = request(fixture.invalidHtml.html);
          const first = await session.validate(
            input,
            new AbortController().signal,
          );
          const second = await session.validate(
            input,
            new AbortController().signal,
          );
          assert(
            jsonEqual(first, second),
            "the same request returned different results across calls",
          );
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "results are JSON serializable and free of non-JSON values",
      async run() {
        const session = await createSession(fixture);
        try {
          const result = await session.validate(
            request(fixture.invalidHtml.html),
            new AbortController().signal,
          );
          const { normalized, error: normalizeError } =
            tryNormalizeForJson(result);
          assert(
            normalizeError === undefined,
            `result contained a non-JSON-safe value: ${normalizeError}`,
          );
          let serialized: string;
          try {
            serialized = JSON.stringify(result);
          } catch (error) {
            throw new Error(
              `JSON.stringify(result) threw: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          const roundTripped: unknown = JSON.parse(serialized);
          assert(
            JSON.stringify(roundTripped) === JSON.stringify(normalized),
            "result did not round-trip through JSON (aside from dropped `undefined` fields)",
          );
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "validate does not mutate the request object",
      async run() {
        const session = await createSession(fixture);
        try {
          const input = request(fixture.invalidHtml.html);
          const snapshot = structuredClone(input);
          await session.validate(input, new AbortController().signal);
          assert(
            jsonEqual(input, snapshot),
            "validate() mutated the request object it was given",
          );
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "pre-aborted validation rejects with AbortError",
      async run() {
        const session = await createSession(fixture);
        const controller = new AbortController();
        controller.abort();
        try {
          const { result, thrown } = await settle(
            session.validate(request(fixture.validHtml), controller.signal),
          );
          assert(
            thrown instanceof Error && thrown.name === "AbortError",
            result !== undefined
              ? `pre-aborted validate resolved instead of rejecting with AbortError ` +
                  `(diagnostics=${result.diagnostics.length}, failures=${JSON.stringify(result.failures)})`
              : `pre-aborted validate rejected but not with AbortError: ${String(thrown)}`,
          );
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "aborting mid-validation surfaces AbortError, never an execution-error failure",
      async run() {
        const session = await createSession(fixture);
        try {
          const controller = new AbortController();
          const pending = session.validate(
            request(fixture.validHtml),
            controller.signal,
          );
          controller.abort();
          const { result, thrown } = await settle(pending);
          if (thrown !== undefined) {
            assert(
              thrown instanceof Error && thrown.name === "AbortError",
              `mid-validation abort rejected but not with AbortError: ${String(thrown)}`,
            );
          } else {
            assert(
              result !== undefined &&
                !result.failures.some(
                  (failure) => failure.code === "execution-error",
                ),
              "mid-validation abort resolved with an execution-error failure instead of an AbortError rejection",
            );
          }
        } finally {
          await session.dispose();
        }
      },
    },
    {
      name: "dispose is idempotent",
      async run() {
        const session = await createSession(fixture);
        await session.dispose();
        await session.dispose();
      },
    },
    {
      name: "sessions do not leak state into each other",
      async run() {
        const sessionA = await createSession(fixture);
        const sessionB = await createSession(fixture);
        try {
          const [resultA, resultB] = await Promise.all([
            sessionA.validate(
              request(fixture.invalidHtml.html),
              new AbortController().signal,
            ),
            sessionB.validate(
              request(fixture.validHtml),
              new AbortController().signal,
            ),
          ]);
          assert(
            resultA.diagnostics.length > 0,
            "session validating invalid HTML produced no diagnostics — did a sibling session's state leak in?",
          );
          assert(
            resultB.diagnostics.length === 0,
            "session validating valid HTML unexpectedly produced diagnostics — did a sibling session's state leak in?",
          );
        } finally {
          await sessionA.dispose();
          await sessionB.dispose();
        }
      },
    },
    {
      name: "concurrent validate calls within maxConcurrentValidations match sequential results",
      async run() {
        const session = await createSession(fixture);
        try {
          // Never issue more concurrent calls than the adapter declares it
          // can handle (design doc §3.8); 3 is plenty to exercise ordering
          // without being slow for adapters that report a large limit.
          const limit = Math.max(
            1,
            Math.min(fixture.adapter.capabilities.maxConcurrentValidations, 3),
          );
          const requests = Array.from({ length: limit }, (_, index) =>
            request(
              index % 2 === 0 ? fixture.invalidHtml.html : fixture.validHtml,
            ),
          );

          const sequential: ValidateHtmlResult[] = [];
          for (const oneRequest of requests) {
            sequential.push(
              await session.validate(oneRequest, new AbortController().signal),
            );
          }

          const concurrent = await Promise.all(
            requests.map((oneRequest) =>
              session.validate(oneRequest, new AbortController().signal),
            ),
          );

          assert(
            jsonEqual(sequential, concurrent),
            "concurrent validate() results did not match sequential validate() results",
          );
        } finally {
          await session.dispose();
        }
      },
    },
    ...(fixture.adapter.capabilities.fragmentHandling === "wrapped"
      ? [
          {
            name: "wrapped-mode diagnostics are fragment-relative and exclude wrapper-only violations",
            async run() {
              const session = await createSession(fixture);
              try {
                const result = await session.validate(
                  request(fixture.invalidHtml.html),
                  new AbortController().signal,
                );
                for (const diagnostic of result.diagnostics) {
                  if (!diagnostic.range) continue;
                  assert(
                    diagnostic.range.start >= 0 &&
                      diagnostic.range.end <= fixture.invalidHtml.html.length,
                    "wrapped adapter returned a diagnostic range outside the fragment — " +
                      "the wrapper offset was not corrected back to request.html coordinates",
                  );
                }
                const validResult = await session.validate(
                  request(fixture.validHtml),
                  new AbortController().signal,
                );
                assert(
                  validResult.diagnostics.length === 0,
                  "wrapped adapter reported a diagnostic for otherwise-valid fragment HTML — " +
                    "likely leaked from its own wrapper markup",
                );
              } finally {
                await session.dispose();
              }
            },
          } satisfies AdapterContractCase,
        ]
      : []),
    ...(fixture.createFailureSettings
      ? [
          {
            name: "configuration failures stay outside diagnostics",
            async run() {
              try {
                const session = await fixture.adapter.createSession({
                  workspaceRoot: fixture.workspaceRoot,
                  settings: fixture.createFailureSettings!(),
                  logger: nullLogger,
                });
                const result = await session.validate(
                  request(fixture.validHtml),
                  new AbortController().signal,
                );
                await session.dispose();
                assert(
                  result.diagnostics.length === 0 &&
                    result.failures.some(
                      (failure) => failure.code === "configuration-error",
                    ),
                  "configuration failure was not separated",
                );
              } catch (error) {
                assert(
                  isAdapterSessionFailure(error),
                  "createSession rejection did not use AdapterSessionFailure",
                );
              }
            },
          } satisfies AdapterContractCase,
        ]
      : []),
    ...(fixture.expectedConfigWatchTargets
      ? [
          {
            name: "config watch targets are absolute, sorted, deduplicated and refreshed after validation",
            async run() {
              const session = await createSession(fixture);
              try {
                await session.validate(
                  request(fixture.invalidHtml.html),
                  new AbortController().signal,
                );
                const first = session.getConfigWatchTargets?.() ?? [];
                const second = session.getConfigWatchTargets?.() ?? [];
                assert(
                  jsonEqual(first, second),
                  "watch targets were not deterministic across repeated calls",
                );
                assert(
                  first.every(
                    (target) =>
                      isAbsolute(target.absolutePath) &&
                      target.absolutePath === normalize(target.absolutePath),
                  ),
                  "watch targets must be normalized absolute paths",
                );
                const seen = new Set<string>();
                for (const target of first) {
                  const key = `${target.kind}:${target.absolutePath}`;
                  assert(
                    !seen.has(key),
                    `watch targets contained a duplicate entry: ${key}`,
                  );
                  seen.add(key);
                }
                const sortedByPath = [...first].sort((a, b) =>
                  a.absolutePath.localeCompare(b.absolutePath),
                );
                assert(
                  jsonEqual(first, sortedByPath),
                  "watch targets were not sorted by absolutePath",
                );
                assert(
                  first.length > 0,
                  "getConfigWatchTargets() returned no targets after validate() — expected it to be refreshed/populated",
                );
                assert(
                  jsonEqual(first, fixture.expectedConfigWatchTargets),
                  "watch target snapshot differed from the fixture's expectedConfigWatchTargets",
                );
              } finally {
                await session.dispose();
              }
            },
          } satisfies AdapterContractCase,
        ]
      : []),
  ];
}

async function createSession<TSettings>(
  fixture: AdapterContractFixture<TSettings>,
) {
  return fixture.adapter.createSession({
    workspaceRoot: fixture.workspaceRoot,
    settings: fixture.settings,
    logger: nullLogger,
  });
}

/** Awaits `promise`, capturing either its resolution or its rejection. */
async function settle(
  promise: Promise<ValidateHtmlResult>,
): Promise<{ result: ValidateHtmlResult | undefined; thrown: unknown }> {
  try {
    return { result: await promise, thrown: undefined };
  } catch (error) {
    return { result: undefined, thrown: error };
  }
}

function tryNormalizeForJson(value: unknown): {
  normalized: unknown;
  error?: string;
} {
  try {
    return { normalized: normalizeForJson(value) };
  } catch (error) {
    return {
      normalized: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
