import { describe, expect, it } from "vitest";
import { createAdapterContractCases, createNoBlinkAdapter } from "./index.js";
import { createFakeAdapter } from "./fake.js";

describe("adapter-testkit", () => {
  it("runs framework-neutral contract cases", async () => {
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
    });
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
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const pending = session.validate(
      {
        html: "<p></p>",
        documentKind: "fragment",
        sourceFilename: "/workspace/A.vue",
        virtualFilename: "/workspace/A.vue.__vue_html_bridge__/variant-x.html",
      },
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
});
