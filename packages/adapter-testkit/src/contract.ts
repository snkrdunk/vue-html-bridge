import {
  checkHtmlValidatorAdapter,
  isAdapterSessionFailure,
  nullLogger,
  type ConfigWatchTarget,
  type DiagnosticSeverity,
  type HtmlValidatorAdapter,
  type ValidateHtmlRequest,
} from "@vue-html-bridge/validator-api";
import { isAbsolute, normalize } from "node:path";

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

export function createAdapterContractCases<TSettings>(
  fixture: AdapterContractFixture<TSettings>,
): readonly AdapterContractCase[] {
  const request = (html: string): ValidateHtmlRequest => ({
    html,
    documentKind: "fragment",
    sourceFilename: `${fixture.workspaceRoot}/Fixture.vue`,
    virtualFilename: `${fixture.workspaceRoot}/Fixture.vue.__vue_html_bridge__/variant-contract.html`,
  });

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
          const diagnostic = result.diagnostics.find(
            (item) =>
              fixture.invalidHtml.expectedRuleId === undefined ||
              item.ruleId === fixture.invalidHtml.expectedRuleId,
          );
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
    {
      name: "results are deterministic and JSON serializable",
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
            JSON.stringify(first) === JSON.stringify(second),
            "same request returned different results",
          );
          assert(
            JSON.stringify(JSON.parse(JSON.stringify(first))) ===
              JSON.stringify(first),
            "result was not JSON serializable",
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
          await session.validate(request(fixture.validHtml), controller.signal);
          throw new Error("pre-aborted validation unexpectedly resolved");
        } catch (error) {
          assert(
            error instanceof Error && error.name === "AbortError",
            "abort was not preserved",
          );
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
          },
        ]
      : []),
    ...(fixture.expectedConfigWatchTargets
      ? [
          {
            name: "config watch targets are absolute, sorted and deterministic",
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
                  JSON.stringify(first) === JSON.stringify(second),
                  "watch targets were not deterministic",
                );
                assert(
                  first.every(
                    (target) =>
                      isAbsolute(target.absolutePath) &&
                      target.absolutePath === normalize(target.absolutePath),
                  ),
                  "watch targets must be normalized absolute paths",
                );
                assert(
                  JSON.stringify(first) ===
                    JSON.stringify(fixture.expectedConfigWatchTargets),
                  "watch target snapshot differed",
                );
              } finally {
                await session.dispose();
              }
            },
          },
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

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
