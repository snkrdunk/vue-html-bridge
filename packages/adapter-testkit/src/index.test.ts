import { describe, expect, it } from "vitest";
import {
  AdapterSessionFailureError,
  VALIDATOR_API_VERSION,
  isValidateHtmlResult,
  nullLogger,
  type AdapterCapabilities,
  type HtmlValidatorAdapter,
  type ValidateHtmlRequest,
  type ValidateHtmlResult,
} from "@vue-html-bridge/validator-api";
import {
  createAdapterContractCases,
  createNoBlinkAdapter,
  type AdapterContractFixture,
} from "./index.js";
import { createFakeAdapter } from "./fake.js";

function makeRequest(
  html: string,
  workspaceRoot = "/workspace",
): ValidateHtmlRequest {
  return {
    html,
    documentKind: "fragment",
    sourceFilename: `${workspaceRoot}/A.vue`,
    virtualFilename: `${workspaceRoot}/A.vue.__vue_html_bridge__/variant-x.html`,
  };
}

describe("adapter-testkit", () => {
  it("runs framework-neutral contract cases (design §8 item 1) — including the failure-vs-diagnostic case (design §5)", async () => {
    const cases = createAdapterContractCases({
      adapter: createNoBlinkAdapter(),
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "<p>text</p>",
      invalidHtml: {
        html: "<blink>text</blink>",
        expectedRuleId: "no-blink",
        expectedSubstring: "blink",
      },
      // Exercises the no-blink sample's failOnCreate settings, demonstrating
      // the failure/diagnostic distinction (design §5) with a real running
      // test rather than only in a code snippet.
      createFailureSettings: () => ({ failOnCreate: true }),
    });
    expect(cases.length).toBeGreaterThan(10);
    for (const contractCase of cases) await contractCase.run();
  });

  it("captures fake calls, queued results, barriers and dispose", async () => {
    const fake = createFakeAdapter();
    fake.enqueue({
      diagnostics: [{ severity: "warning", message: "fixture" }],
      failures: [],
    });
    const barrier = fake.blockNext();
    const session = await fake.adapter.createSession({
      workspaceRoot: "/workspace",
      settings: { label: "one" },
      logger: nullLogger,
    });
    const pending = session.validate(
      makeRequest("<p></p>"),
      new AbortController().signal,
    );
    expect(fake.calls).toHaveLength(1);
    barrier.resolve();
    await expect(pending).resolves.toMatchObject({
      diagnostics: [{ message: "fixture" }],
    });
    await session.dispose();
    await session.dispose();
    expect(fake.disposeCount).toBe(1);
  });

  it("the fake adapter rejects when an Error is enqueued (design §8 item 9's throw behavior)", async () => {
    const fake = createFakeAdapter();
    fake.enqueue(new Error("simulated validator crash"));
    const session = await fake.adapter.createSession({
      workspaceRoot: "/workspace",
      settings: {},
      logger: nullLogger,
    });
    await expect(
      session.validate(makeRequest("<p></p>"), new AbortController().signal),
    ).rejects.toThrow("simulated validator crash");
    await session.dispose();
  });

  it("the fake adapter tracks concurrent call counts via activeCalls/maximumActiveCalls", async () => {
    const fake = createFakeAdapter({ maxConcurrentValidations: 2 });
    const session = await fake.adapter.createSession({
      workspaceRoot: "/workspace",
      settings: {},
      logger: nullLogger,
    });
    const first = fake.blockNext();
    const second = fake.blockNext();
    const pendingFirst = session.validate(
      makeRequest("<p>1</p>"),
      new AbortController().signal,
    );
    const pendingSecond = session.validate(
      makeRequest("<p>2</p>"),
      new AbortController().signal,
    );
    expect(fake.activeCalls).toBe(2);
    expect(fake.maximumActiveCalls).toBe(2);
    first.resolve();
    second.resolve();
    await Promise.all([pendingFirst, pendingSecond]);
    expect(fake.activeCalls).toBe(0);
    expect(fake.maximumActiveCalls).toBe(2);
    expect(fake.calls).toHaveLength(2);
    await session.dispose();
  });

  it("the fake adapter's getConfigWatchTargets reflects setConfigWatchTargets", async () => {
    const fake = createFakeAdapter();
    fake.setConfigWatchTargets([
      { absolutePath: "/workspace/.fake-validator.json", kind: "config" },
    ]);
    const session = await fake.adapter.createSession({
      workspaceRoot: "/workspace",
      settings: {},
      logger: nullLogger,
    });
    expect(session.getConfigWatchTargets?.()).toEqual([
      { absolutePath: "/workspace/.fake-validator.json", kind: "config" },
    ]);
    await session.dispose();
  });

  it("supports diagnostics with no range instead of an invented position (design §3.3)", async () => {
    const fake = createFakeAdapter();
    fake.enqueue({
      diagnostics: [{ severity: "error", message: "unlocatable violation" }],
      failures: [],
    });
    const session = await fake.adapter.createSession({
      workspaceRoot: "/workspace",
      settings: {},
      logger: nullLogger,
    });
    const result = await session.validate(
      makeRequest("<p></p>"),
      new AbortController().signal,
    );
    await session.dispose();
    expect(result.diagnostics[0]?.range).toBeUndefined();
    // Confirms `range: undefined` is a valid shape per the SPI's own runtime
    // check, not merely an accident of this test.
    expect(isValidateHtmlResult(result)).toBe(true);
  });
});

/**
 * Self-tests: broken adapters are caught by the contract (design doc §6).
 *
 * Each fixture below implements `HtmlValidatorAdapter` in a way that is
 * *almost* correct except for exactly one deliberate defect. We then assert
 * that the matching contract case — not just "some case" — actually fails
 * against it. This is what keeps the contract suite honest: a case that
 * can never fail is a case that isn't really checking anything.
 */
describe("self-tests: broken adapters are caught by the contract (design §6, §8 item 10)", () => {
  const BASE_CAPABILITIES: AdapterCapabilities = {
    execution: "in-process",
    supportsCancellation: true,
    supportsConfigFiles: false,
    fragmentHandling: "native",
    maxConcurrentValidations: 4,
  };

  async function expectCaseToFail<TSettings>(
    fixture: AdapterContractFixture<TSettings>,
    nameContains: string,
  ): Promise<void> {
    const cases = createAdapterContractCases(fixture);
    const target = cases.find((contractCase) =>
      contractCase.name.includes(nameContains),
    );
    if (!target) {
      throw new Error(
        `no contract case name contains "${nameContains}" (available: ${cases
          .map((c) => c.name)
          .join(" | ")})`,
      );
    }
    await expect(target.run()).rejects.toThrow();
  }

  it("1: wrong code-point offsets are caught by the UTF-16 boundary cases", async () => {
    const target = "TARGET";
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-wrong-offset",
      displayName: "Broken: code-point offset instead of UTF-16",
      capabilities: BASE_CAPABILITIES,
      async createSession() {
        let disposed = false;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("disposed");
            const codePoints = Array.from(request.html);
            let index = -1;
            for (let i = 0; i <= codePoints.length - target.length; i += 1) {
              if (codePoints.slice(i, i + target.length).join("") === target) {
                index = i;
                break;
              }
            }
            if (index === -1) return { diagnostics: [], failures: [] };
            // BUG: `index` counts *code points* (Array.from splits by code
            // point), but GeneratedRange must be UTF-16 code units — these
            // diverge once an astral character (2 code units, 1 code point)
            // precedes the match.
            return {
              diagnostics: [
                {
                  ruleId: "found-target",
                  severity: "error",
                  message: `found ${target}`,
                  range: { start: index, end: index + target.length },
                },
              ],
              failures: [],
            };
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "nothing to see here",
      invalidHtml: {
        html: "before TARGET after",
        expectedRuleId: "found-target",
        expectedSubstring: "TARGET",
      },
    };
    await expectCaseToFail(fixture, "leading astral emoji");
  });

  it("2: wrong/unstable diagnostic ordering is caught by the ordering contract case", async () => {
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-ordering",
      displayName: "Broken: diagnostics not in contracted order",
      capabilities: BASE_CAPABILITIES,
      async createSession() {
        let disposed = false;
        return {
          async validate(_request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("disposed");
            // BUG: always returns diagnostics in descending range order,
            // never the range/rule/message order the contract requires
            // (design doc §3.4) — consistent, so this is a pure ordering
            // defect rather than a determinism defect.
            return {
              diagnostics: [
                {
                  ruleId: "second",
                  severity: "error",
                  message: "B",
                  range: { start: 3, end: 4 },
                },
                {
                  ruleId: "first",
                  severity: "error",
                  message: "A",
                  range: { start: 0, end: 1 },
                },
              ],
              failures: [],
            };
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: {
        html: "AAAA",
        expectedRuleId: "first",
        expectedSubstring: "A",
      },
    };
    await expectCaseToFail(fixture, "contracted order");
  });

  it("3: converting abort into an execution-error failure is caught by the pre-abort contract case", async () => {
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-abort-as-failure",
      displayName: "Broken: abort reported as execution-error",
      capabilities: BASE_CAPABILITIES,
      async createSession() {
        let disposed = false;
        return {
          async validate(_request, signal) {
            if (disposed) throw new Error("disposed");
            // BUG: an aborted signal must reject with AbortError
            // (validator-api / design doc §3.6), never be downgraded into an
            // ordinary failure.
            if (signal.aborted) {
              return {
                diagnostics: [],
                failures: [
                  {
                    code: "execution-error",
                    message: "aborted",
                    recoverable: false,
                  },
                ],
              };
            }
            return { diagnostics: [], failures: [] };
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: { html: "bad", expectedSubstring: "bad" },
    };
    await expectCaseToFail(fixture, "pre-aborted");
  });

  it("4: an Error instance in metadata is caught by the JSON-serializability contract case", async () => {
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-error-metadata",
      displayName: "Broken: Error instance in metadata",
      capabilities: BASE_CAPABILITIES,
      async createSession() {
        let disposed = false;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("disposed");
            // BUG: `metadata` must be plain JSON (design doc §3.9); an Error
            // instance is not — bypass the type system the way a careless
            // real adapter would at runtime.
            return {
              diagnostics: [],
              failures: [],
              metadata: { cause: new Error("boom") },
            } as unknown as ValidateHtmlResult;
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: { html: "bad", expectedSubstring: "bad" },
    };
    await expectCaseToFail(fixture, "JSON serializable");
  });

  it("5: throwing on the second dispose() call is caught by the idempotent-dispose contract case", async () => {
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-double-dispose",
      displayName: "Broken: throws on second dispose",
      capabilities: BASE_CAPABILITIES,
      async createSession() {
        let disposeCount = 0;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            return { diagnostics: [], failures: [] };
          },
          async dispose() {
            disposeCount += 1;
            // BUG: dispose() must be idempotent (design doc §3.7).
            if (disposeCount > 1) throw new Error("already disposed");
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: { html: "bad", expectedSubstring: "bad" },
    };
    await expectCaseToFail(fixture, "idempotent");
  });

  it("6: a wrapped adapter that fails to correct the wrapper range is caught by the wrapped-mode contract case", async () => {
    const WRAPPER_PREFIX_LENGTH = 20; // pretend "<html><body>"-ish wrapper length
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-wrapped-range",
      displayName: "Broken: uncorrected wrapper range",
      capabilities: { ...BASE_CAPABILITIES, fragmentHandling: "wrapped" },
      async createSession() {
        let disposed = false;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("disposed");
            const realIndex = request.html.indexOf("BAD");
            if (realIndex === -1) return { diagnostics: [], failures: [] };
            // BUG: forgot to translate the wrapped document's offset back to
            // request.html coordinates (design doc §3.8).
            const wrongIndex = realIndex + WRAPPER_PREFIX_LENGTH;
            return {
              diagnostics: [
                {
                  ruleId: "found-bad",
                  severity: "error",
                  message: "found BAD",
                  range: { start: wrongIndex, end: wrongIndex + 3 },
                },
              ],
              failures: [],
            };
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "OK",
      invalidHtml: {
        html: "has BAD text",
        expectedRuleId: "found-bad",
        expectedSubstring: "BAD",
      },
    };
    await expectCaseToFail(fixture, "fragment-relative");
  });

  it("7: an adapter that mutates the request object is caught by the request-immutability contract case", async () => {
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-mutates-request",
      displayName: "Broken: mutates the request object",
      capabilities: BASE_CAPABILITIES,
      async createSession() {
        let disposed = false;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("disposed");
            // BUG: validate() must not modify the request object it is
            // given (design doc §3.8).
            request.sourceFilename = "MUTATED";
            return { diagnostics: [], failures: [] };
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: { html: "bad", expectedSubstring: "bad" },
    };
    await expectCaseToFail(fixture, "mutate the request object");
  });

  it("8: invalid capabilities (missing maxConcurrentValidations) are caught by the runtime-boundary contract case", async () => {
    const brokenCapabilities = {
      execution: "in-process",
      supportsCancellation: true,
      supportsConfigFiles: false,
      fragmentHandling: "native",
      // BUG: maxConcurrentValidations intentionally omitted — invalid per
      // validator-api's runtime shape check (design doc §6).
    } as unknown as AdapterCapabilities;
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-capabilities",
      displayName: "Broken: missing maxConcurrentValidations",
      capabilities: brokenCapabilities,
      async createSession() {
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            return { diagnostics: [], failures: [] };
          },
          async dispose() {},
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: { html: "bad", expectedSubstring: "bad" },
    };
    await expectCaseToFail(fixture, "runtime boundary");
  });

  it("9: a relative (non-absolute) config watch target is caught by the watch-target contract case", async () => {
    const adapter: HtmlValidatorAdapter<Record<string, never>> = {
      apiVersion: VALIDATOR_API_VERSION,
      id: "broken-relative-watch-target",
      displayName: "Broken: relative watch target",
      capabilities: {
        ...BASE_CAPABILITIES,
        supportsConfigFiles: true,
        configFilePatterns: ["**/.brokenrc.json"],
      },
      async createSession() {
        let disposed = false;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("disposed");
            return { diagnostics: [], failures: [] };
          },
          getConfigWatchTargets() {
            // BUG: must be a normalized absolute path (design doc §3.10).
            return [
              { absolutePath: "relative/.brokenrc.json", kind: "config" },
            ];
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    };
    const fixture: AdapterContractFixture<Record<string, never>> = {
      adapter,
      workspaceRoot: "/workspace",
      settings: {},
      validHtml: "ok",
      invalidHtml: { html: "<div></div>", expectedSubstring: "div" },
      expectedConfigWatchTargets: [
        { absolutePath: "/workspace/.brokenrc.json", kind: "config" },
      ],
    };
    await expectCaseToFail(fixture, "watch targets");
  });
});

describe("design §5: the no-blink sample adapter's own createSession failure path", () => {
  it("throws AdapterSessionFailureError with a configuration-error code when failOnCreate is set", async () => {
    const adapter = createNoBlinkAdapter();
    await expect(
      adapter.createSession({
        workspaceRoot: "/workspace",
        settings: { failOnCreate: true },
        logger: nullLogger,
      }),
    ).rejects.toBeInstanceOf(AdapterSessionFailureError);
  });
});
