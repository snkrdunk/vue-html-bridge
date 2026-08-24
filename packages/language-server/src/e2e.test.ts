// Vertical-slice E2E (implementation-plan.md Phase 1 Step 7): a real
// in-memory JSON-RPC harness talking to the real startLanguageServer, the
// real analyzer, and (by default) the real Markuplint adapter — nothing here
// is mocked except where a test deliberately injects a failure or a
// controllable delay.
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, type Connection } from "vscode-languageserver/node";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { createFakeAdapter } from "@vue-html-bridge/adapter-testkit/fake";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import {
  createTypeAnalysisContext,
  createWorkspaceAnalyzer,
  type WorkspaceAnalyzer,
} from "@vue-html-bridge/analyzer";
import { startLanguageServer, type LanguageServerHandle } from "./index.js";

interface NotificationRecord {
  method: string;
  params: unknown;
}

type PublishDiagnosticsParams = {
  uri: string;
  version?: number;
  diagnostics: readonly {
    code?: string;
    source?: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }[];
};

interface Harness {
  client: MessageConnection;
  notifications: NotificationRecord[];
  waitForNotification(
    method: string,
    predicate?: (params: PublishDiagnosticsParams) => boolean,
    timeoutMs?: number,
  ): Promise<PublishDiagnosticsParams>;
  dispose(): Promise<void>;
}

function startHarness(
  createWorkspaceAnalyzerOverride?: (
    workspaceRoot: string,
  ) => Promise<WorkspaceAnalyzer>,
): Harness {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const serverConnection: Connection = createConnection(
    clientToServer,
    serverToClient,
  );
  const client = createMessageConnection(serverToClient, clientToServer);

  const notifications: NotificationRecord[] = [];
  client.onNotification((method: string, params: unknown) => {
    notifications.push({ method, params });
  });
  client.listen();

  const handle: LanguageServerHandle = startLanguageServer({
    connection: serverConnection,
    createWorkspaceAnalyzer: createWorkspaceAnalyzerOverride,
  });

  async function waitForNotification(
    method: string,
    predicate: (params: PublishDiagnosticsParams) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<PublishDiagnosticsParams> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = notifications.find(
        (n) =>
          n.method === method &&
          predicate(n.params as PublishDiagnosticsParams),
      );
      if (match) return match.params as PublishDiagnosticsParams;
      if (Date.now() > deadline) {
        throw new Error(`waitForNotification: timed out waiting for ${method}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    client,
    notifications,
    waitForNotification,
    async dispose() {
      await handle.dispose();
      client.dispose();
      // Deliberately does not end/destroy the PassThrough streams:
      // vscode-languageserver/node's createConnection() always wires
      // input.on('end'|'close', () => process.exit(...)) to mirror real
      // stdio shutdown, which would kill the test worker. Un-referenced
      // streams are simply left for GC once the test's variables go away.
    },
  };
}

async function initialize(
  client: MessageConnection,
  rootUri = "file:///workspace",
) {
  const result = await client.sendRequest<{
    capabilities: Record<string, unknown>;
  }>("initialize", {
    processId: null,
    rootUri,
    capabilities: {},
  });
  await client.sendNotification("initialized", {});
  return result;
}

function didOpen(
  client: MessageConnection,
  uri: string,
  text: string,
  version = 1,
) {
  return client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "vue", version, text },
  });
}

function didChangeFullText(
  client: MessageConnection,
  uri: string,
  text: string,
  version: number,
) {
  return client.sendNotification("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function harness(
  createWorkspaceAnalyzerOverride?: (
    workspaceRoot: string,
  ) => Promise<WorkspaceAnalyzer>,
): Harness {
  const h = startHarness(createWorkspaceAnalyzerOverride);
  harnesses.push(h);
  return h;
}

describe("vertical-slice E2E: monorepo.md §12.2 Phase 2 items", () => {
  it("correlation: a v-if and a dynamic attribute referencing the same expression never contradict each other", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);
    const uri = "file:///workspace/Correlate.vue";
    // If loggedIn and !loggedIn were independently expanded (no correlation),
    // one of the 4 candidate variants would have BOTH elements present at
    // once (an internally contradictory state), colliding on id="dup" — a
    // real Markuplint id-duplication violation that can never actually
    // happen at runtime, since the two conditions are mutually exclusive by
    // construction.
    await didOpen(
      client,
      uri,
      `<script setup lang="ts">
defineProps<{ loggedIn: boolean }>();
</script>
<template>
  <div v-if="loggedIn" id="dup"></div>
  <div v-if="!loggedIn" id="dup"></div>
</template>`,
    );
    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri,
    );
    expect(
      published.diagnostics.some(
        (d: { code?: string }) => d.code === "id-duplication",
      ),
    ).toBe(false);
  });

  it("v-for cardinality correlates with a matching .length condition on the same collection", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);
    const uri = "file:///workspace/CardinalityLength.vue";
    // If cardinality and the two complementary .length checks were
    // independently expanded, some candidate variant would show both the
    // "empty" and "non-empty" markers at once (both true.length === 0 and
    // .length > 0 can never both hold), colliding on id="marker".
    await didOpen(
      client,
      uri,
      `<script setup lang="ts">
defineProps<{ items: string[] }>();
</script>
<template>
  <ul><li v-for="item in items"></li></ul>
  <p v-if="items.length === 0" id="marker"></p>
  <span v-if="items.length > 0" id="marker"></span>
</template>`,
    );
    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri,
    );
    expect(
      published.diagnostics.some(
        (d: { code?: string }) => d.code === "id-duplication",
      ),
    ).toBe(false);
  });

  it("aggregation: the same source-level problem across multiple variants is published as a single diagnostic", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);
    const uri = "file:///workspace/Aggregate.vue";
    // "dup" appears twice in every variant regardless of `a`, but at a
    // different generated offset each time (the preceding <p> only exists
    // when a is true) — the analyzer must still report this as one
    // aggregated diagnostic (analyzer.md §8.2), not one per variant.
    await didOpen(
      client,
      uri,
      `<script setup lang="ts">
defineProps<{ a: boolean }>();
</script>
<template>
  <p v-if="a">x</p>
  <span id="dup"></span>
  <span id="dup"></span>
</template>`,
    );
    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri,
    );
    const matches = published.diagnostics.filter(
      (d: { code?: string }) => d.code === "id-duplication",
    );
    expect(matches).toHaveLength(1);
  });

  it("related information: multiple source origins for one generated diagnostic are reported together", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        // Two equal-length attribute values sit adjacent in the generated
        // HTML. A diagnostic range spanning the second half of the first
        // value through the first half of the second overlaps both
        // attribute-value mapping entries by an equal amount (5 chars
        // each) — larger than the short "b" attribute-name span in
        // between, so both values tie for "most specific" and both
        // surface (§6.1: largest overlap, then attribute-value priority).
        const aStart = request.html.indexOf('a="') + 'a="'.length;
        const bStart = request.html.indexOf('b="') + 'b="'.length;
        return {
          diagnostics: [
            {
              ruleId: "spans-two-attributes",
              severity: "warning",
              message: "spans two attribute values",
              range: { start: aStart + 5, end: bStart + 5 },
            },
          ],
          failures: [],
        };
      },
    });
    const { client, waitForNotification } = harness(async (workspaceRoot) =>
      createWorkspaceAnalyzer({
        workspaceRoot,
        adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
        typeContext: createTypeAnalysisContext(),
      }),
    );
    await initialize(client);
    const uri = "file:///workspace/Related.vue";
    await didOpen(
      client,
      uri,
      `<template><div a="xxxxxxxxxx" b="yyyyyyyyyy"></div></template>`,
    );

    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) =>
        params.uri === uri &&
        params.diagnostics.some(
          (d: { code?: string }) => d.code === "spans-two-attributes",
        ),
    );
    const diagnostic = published.diagnostics.find(
      (d: { code?: string }) => d.code === "spans-two-attributes",
    ) as { relatedInformation?: unknown[] } | undefined;
    expect(diagnostic).toBeDefined();
    expect((diagnostic!.relatedInformation ?? []).length).toBeGreaterThan(0);
  });
});

describe("vertical-slice E2E (language-server.md §13.2 items 1-3,6; §13.3)", () => {
  it("13.2-1: initialize negotiates UTF-16 position encoding", async () => {
    const { client } = harness();
    const result = await initialize(client);
    expect(result.capabilities.positionEncoding).toBe("utf-16");
    expect(result.capabilities.textDocumentSync).toBe(2); // Incremental
  });

  it("13.2-2/13.3: publishes a real Markuplint violation at the correct source position, only in the affected variant", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);

    const fixturePath = fileURLToPath(
      new URL(
        "../../../examples/playground/logged-in-aria-controls.vue",
        import.meta.url,
      ),
    );
    const source = await readFile(fixturePath, "utf8");
    const uri = "file:///workspace/Menu.vue";
    await didOpen(client, uri, source);

    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.diagnostics.length > 0,
    );
    expect(published.version).toBe(1);
    // Only one variant is affected — id="user-menu" only exists on the
    // v-if branch, so this fires exactly once, not once per variant.
    const matches = published.diagnostics.filter(
      (d: { code?: string }) => d.code === "no-refer-to-non-existent-id",
    );
    expect(matches).toHaveLength(1);
    const diagnostic = matches[0]!;
    expect(diagnostic.source).toBe("vue-html-bridge/markuplint");
    // Range maps back to the :aria-controls ternary expression, not the whole button.
    const line = source.split("\n")[diagnostic.range.start.line];
    expect(line).toContain("aria-controls");
    expect(
      source.slice(
        offsetFromPosition(source, diagnostic.range.start),
        offsetFromPosition(source, diagnostic.range.end),
      ),
    ).toBe("props.loggedIn ? 'missing' : undefined");
  });

  it("13.2-3: an incremental didChange re-analyzes the new (unsaved) text", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);
    const uri = "file:///workspace/Ids.vue";
    await didOpen(
      client,
      uri,
      `<template><div id="x"></div><div id="x"></div></template>`,
    );
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.version === 1,
    );

    await didChangeFullText(
      client,
      uri,
      `<template><div id="x"></div><div id="y"></div></template>`,
      2,
    );
    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.version === 2,
    );
    expect(
      published.diagnostics.some(
        (d: { code?: string }) => d.code === "id-duplication",
      ),
    ).toBe(false);
  });

  it("13.2-6: didClose publishes an empty diagnostics list", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);
    const uri = "file:///workspace/Closing.vue";
    await didOpen(
      client,
      uri,
      `<template><div id="x"></div><div id="x"></div></template>`,
    );
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.diagnostics.length > 0,
    );

    await client.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.diagnostics.length === 0,
    );
    expect(published.diagnostics).toEqual([]);
  });

  it("UTF-16 correctness: emoji and an escaped attribute-value newline map to the correct range (monorepo.md §12.2)", async () => {
    const { client, waitForNotification } = harness();
    await initialize(client);
    const uri = "file:///workspace/Emoji.vue";
    // Emoji before the target attribute (surrogate pair) and a newline inside
    // a static attribute value (core.md §2.2 escapes it to &#10; in the
    // generated HTML; the source mapping must still resolve to this exact
    // source span).
    const source =
      '<template><p>\u{1F600}</p><div id="x\ny"></div><div id="x\ny"></div></template>';
    await didOpen(client, uri, source);

    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.diagnostics.length > 0,
    );
    const diagnostic = published.diagnostics.find(
      (d: { code?: string }) => d.code === "id-duplication",
    );
    expect(diagnostic).toBeDefined();
    // The reported range covers the id value "x\ny" (including the literal
    // newline). It must land there exactly — neither shifted by the earlier
    // emoji's 2-UTF-16-code-unit width nor by the generated HTML's own
    // &#10;-escaping of that newline (core.md §2.2), since ranges here are
    // in *source* coordinates, not generated-HTML coordinates.
    const start = offsetFromPosition(source, diagnostic!.range.start);
    const end = offsetFromPosition(source, diagnostic!.range.end);
    expect(source.slice(start, end)).toBe("x\ny");
  });

  it("core diagnostics are still published when the Markuplint adapter's session fails to start", async () => {
    const { client, waitForNotification } = harness(async (workspaceRoot) =>
      createWorkspaceAnalyzer({
        workspaceRoot,
        adapters: [
          {
            adapter: markuplintAdapter,
            settings: { configFile: "does-not-exist.json" },
            enabled: true,
          },
        ],
        typeContext: createTypeAnalysisContext(),
      }),
    );
    await initialize(client);
    const uri = "file:///workspace/Broken.vue";
    // A core-level diagnostic: pug templates are unsupported (core.md §1).
    await didOpen(client, uri, `<template lang="pug">div hi</template>`);

    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.diagnostics.length > 0,
    );
    expect(
      published.diagnostics.some(
        (d: { code?: string }) =>
          d.code === "vue-html-bridge/unsupported-template-source",
      ),
    ).toBe(true);
    expect(
      published.diagnostics.some((d: { code?: string }) =>
        String(d.code ?? "").startsWith(
          "adapter/markuplint/configuration-error",
        ),
      ),
    ).toBe(true);
  });

  it("cancellation: a didChange while analysis is in flight aborts the previous run before it publishes", async () => {
    const fake = createFakeAdapter({ id: "slow" });
    // Deliberately never resolved: v1's validate() call must only ever
    // settle via the abort signal racing this promise (adapter-testkit's
    // abortable()), not by the barrier — proving the abort actually
    // propagates through the whole analyzer -> adapter chain rather than
    // the test just waiting out a timer.
    fake.blockNext();
    const { client, waitForNotification, notifications } = harness(
      async (workspaceRoot) =>
        createWorkspaceAnalyzer({
          workspaceRoot,
          adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
          typeContext: createTypeAnalysisContext(),
        }),
    );
    await initialize(client);
    const uri = "file:///workspace/Slow.vue";

    await didOpen(client, uri, `<template><p>v1</p></template>`);
    // Wait until the (blocked) adapter call for v1 has actually started,
    // proving analysis genuinely reached the validation stage before we
    // supersede it.
    const deadline = Date.now() + 2000;
    while (fake.calls.length === 0) {
      if (Date.now() > deadline) throw new Error("v1 validate() never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await didChangeFullText(client, uri, `<template><p>v2</p></template>`, 2);

    const published = await waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === uri && params.version === 2,
    );
    expect(published).toBeDefined();
    expect(
      notifications.some(
        (n) =>
          n.method === "textDocument/publishDiagnostics" &&
          (n.params as { uri: string; version?: number }).uri === uri &&
          (n.params as { version?: number }).version === 1,
      ),
    ).toBe(false);
  });
});

function offsetFromPosition(
  text: string,
  position: { line: number; character: number },
): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < position.line; i += 1) offset += lines[i]!.length + 1;
  return offset + position.character;
}
