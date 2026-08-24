import { describe, expect, it, vi } from "vitest";
import type { Connection } from "vscode-languageserver/node";
import { createFakeAdapter } from "@vue-html-bridge/adapter-testkit/fake";
import { createWorkspaceAnalyzer } from "@vue-html-bridge/analyzer";
import { startLanguageServer } from "./server.js";

type Handler = (...args: unknown[]) => unknown;

function createFakeConnection() {
  const handlers: Record<string, Handler> = {};
  const sentDiagnostics: {
    uri: string;
    version?: number;
    diagnostics: unknown[];
  }[] = [];
  const sentNotifications: { method: string; params: unknown }[] = [];
  const noop = () => ({ dispose() {} });
  const connection = {
    onInitialize: (handler: Handler) => {
      handlers.initialize = handler;
      return { dispose() {} };
    },
    onInitialized: noop,
    onShutdown: (handler: Handler) => {
      handlers.shutdown = handler;
      return { dispose() {} };
    },
    onExit: (handler: Handler) => {
      handlers.exit = handler;
      return { dispose() {} };
    },
    onDidOpenTextDocument: (handler: Handler) => {
      handlers.didOpen = handler;
      return { dispose() {} };
    },
    onDidChangeTextDocument: (handler: Handler) => {
      handlers.didChange = handler;
      return { dispose() {} };
    },
    onDidCloseTextDocument: (handler: Handler) => {
      handlers.didClose = handler;
      return { dispose() {} };
    },
    onWillSaveTextDocument: noop,
    onWillSaveTextDocumentWaitUntil: noop,
    onDidSaveTextDocument: (handler: Handler) => {
      handlers.didSave = handler;
      return { dispose() {} };
    },
    onHover: (handler: Handler) => {
      handlers.hover = handler;
      return { dispose() {} };
    },
    sendNotification: vi.fn(
      async (type: { method: string }, params: unknown) => {
        sentNotifications.push({ method: type.method, params });
      },
    ),
    sendDiagnostics: vi.fn(
      async (params: {
        uri: string;
        version?: number;
        diagnostics: unknown[];
      }) => {
        sentDiagnostics.push(params);
      },
    ),
    listen: () => {},
  };
  return {
    connection: connection as unknown as Connection,
    handlers,
    sentDiagnostics,
    sentNotifications,
  };
}

// core's generateVariants yields via setImmediate (a real macrotask, not a
// microtask), so waiting out the analysis pipeline needs real timer ticks,
// not just `await Promise.resolve()`.
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("startLanguageServer (language-server.md §4, §6)", () => {
  it("initialize declares UTF-16 position encoding, incremental sync, and hover", async () => {
    const { connection, handlers } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    const result = await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);
    expect(result).toMatchObject({
      capabilities: {
        positionEncoding: "utf-16",
        textDocumentSync: 2,
        hoverProvider: true,
      },
    });
    await handle.dispose();
  });

  it("publishes diagnostics after didOpen, and republishes after didChange", async () => {
    const { connection, handlers, sentDiagnostics } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);

    const uri = "file:///workspace/Toggle.vue";
    const source = `<template><div id="x"></div><div id="x"></div></template>`; // duplicate id
    await (handlers.didOpen as Handler)({
      textDocument: { uri, languageId: "vue", version: 1, text: source },
    } as never);
    await waitUntil(() => sentDiagnostics.length >= 1);

    expect(sentDiagnostics).toHaveLength(1);
    expect(sentDiagnostics[0]!.version).toBe(1);
    expect(
      (sentDiagnostics[0]!.diagnostics as { code?: string }[]).some(
        (d) => d.code === "id-duplication",
      ),
    ).toBe(true);

    await (handlers.didChange as Handler)({
      textDocument: { uri, version: 2 },
      contentChanges: [
        { text: `<template><div id="x"></div><div id="y"></div></template>` },
      ],
    } as never);
    await waitUntil(() => sentDiagnostics.length >= 2);

    expect(sentDiagnostics).toHaveLength(2);
    expect(sentDiagnostics[1]!.version).toBe(2);
    expect(
      (sentDiagnostics[1]!.diagnostics as { code?: string }[]).some(
        (d) => d.code === "id-duplication",
      ),
    ).toBe(false);

    await handle.dispose();
  });

  it("never publishes a stale (superseded) result (§6.5)", async () => {
    const { connection, handlers, sentDiagnostics } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);

    const uri = "file:///workspace/Race.vue";
    await (handlers.didOpen as Handler)({
      textDocument: {
        uri,
        languageId: "vue",
        version: 1,
        text: `<template><p>v1</p></template>`,
      },
    } as never);
    // Immediately supersede before v1's analysis settles.
    await (handlers.didChange as Handler)({
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: `<template><p>v2</p></template>` }],
    } as never);
    await waitUntil(() =>
      sentDiagnostics.some((entry) => entry.uri === uri && entry.version === 2),
    );

    const versionsPublished = sentDiagnostics
      .filter((entry) => entry.uri === uri)
      .map((entry) => entry.version);
    expect(versionsPublished).not.toContain(1);
    expect(versionsPublished[versionsPublished.length - 1]).toBe(2);

    await handle.dispose();
  });

  it("coalesces rapid didChange events into a single debounced analysis (§6.2)", async () => {
    const { connection, handlers, sentDiagnostics } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);

    const uri = "file:///workspace/Debounce.vue";
    await (handlers.didOpen as Handler)({
      textDocument: {
        uri,
        languageId: "vue",
        version: 1,
        text: `<template><p>v1</p></template>`,
      },
    } as never);
    await waitUntil(() => sentDiagnostics.length >= 1);

    // Three rapid edits, all well inside the 200ms debounce window.
    for (const version of [2, 3, 4]) {
      await (handlers.didChange as Handler)({
        textDocument: { uri, version },
        contentChanges: [{ text: `<template><p>v${version}</p></template>` }],
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await waitUntil(
      () => sentDiagnostics.filter((entry) => entry.uri === uri).length >= 2,
      2000,
    );
    // A little extra margin past the debounce window to be sure a second
    // (unwanted) publish for an intermediate version doesn't show up late.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const versions = sentDiagnostics
      .filter((entry) => entry.uri === uri)
      .map((entry) => entry.version);
    expect(versions).toEqual([1, 4]); // only the open, and the final edit
    await handle.dispose();
  });

  it("didSave re-analyzes immediately, bypassing the debounce (§6.3)", async () => {
    const { connection, handlers, sentDiagnostics } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);

    const uri = "file:///workspace/Save.vue";
    await (handlers.didOpen as Handler)({
      textDocument: {
        uri,
        languageId: "vue",
        version: 1,
        text: `<template><p>v1</p></template>`,
      },
    } as never);
    await waitUntil(() => sentDiagnostics.length >= 1);

    await (handlers.didChange as Handler)({
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: `<template><p>v2</p></template>` }],
    } as never);
    await (handlers.didSave as Handler)({
      textDocument: { uri, version: 2 },
    } as never);

    // Published well before the 200ms didChange debounce would have fired.
    const started = Date.now();
    await waitUntil(
      () =>
        sentDiagnostics.some(
          (entry) => entry.uri === uri && entry.version === 2,
        ),
      2000,
    );
    expect(Date.now() - started).toBeLessThan(180);
    await handle.dispose();
  });

  it("hover returns the published diagnostic's message at a matching position, and null elsewhere (§8)", async () => {
    const { connection, handlers, sentDiagnostics } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);

    const uri = "file:///workspace/Hover.vue";
    const source = `<template><div id="x"></div><div id="x"></div></template>`;
    await (handlers.didOpen as Handler)({
      textDocument: { uri, languageId: "vue", version: 1, text: source },
    } as never);
    await waitUntil(() => sentDiagnostics.length >= 1);

    const published = sentDiagnostics[0]!.diagnostics as {
      code?: string;
      range: { start: { line: number; character: number } };
    }[];
    const idDup = published.find((d) => d.code === "id-duplication")!;
    expect(idDup).toBeDefined();

    const hit = (await (handlers.hover as Handler)({
      textDocument: { uri },
      position: idDup.range.start,
    } as never)) as { contents: { value: string } } | null;
    expect(hit).not.toBeNull();
    expect(hit!.contents.value).toContain("id-duplication");

    const miss = (await (handlers.hover as Handler)({
      textDocument: { uri },
      position: { line: 0, character: 0 },
    } as never)) as unknown;
    expect(miss).toBeNull();

    await handle.dispose();
  });

  it("shows a session-level adapter failure notice once per workspace, not once per document (§7.3)", async () => {
    const { connection, handlers, sentNotifications } = createFakeConnection();
    const failingWorkspaceAnalyzer = (workspaceRoot: string) =>
      createWorkspaceAnalyzer({
        workspaceRoot,
        adapters: [
          {
            adapter: {
              apiVersion: 1,
              id: "broken",
              displayName: "Broken",
              capabilities: {
                execution: "in-process",
                supportsCancellation: true,
                supportsConfigFiles: false,
                fragmentHandling: "native",
                maxConcurrentValidations: 1,
              },
              async createSession() {
                throw Object.assign(new Error("bad config"), {
                  name: "AdapterSessionFailure",
                  failure: {
                    code: "configuration-error",
                    message: "bad config",
                    recoverable: true,
                  },
                });
              },
            },
            settings: {},
            enabled: true,
          },
        ],
      });
    const handle = startLanguageServer({
      connection,
      createWorkspaceAnalyzer: failingWorkspaceAnalyzer,
    });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);

    await (handlers.didOpen as Handler)({
      textDocument: {
        uri: "file:///workspace/A.vue",
        languageId: "vue",
        version: 1,
        text: `<template><p>a</p></template>`,
      },
    } as never);
    await (handlers.didOpen as Handler)({
      textDocument: {
        uri: "file:///workspace/B.vue",
        languageId: "vue",
        version: 1,
        text: `<template><p>b</p></template>`,
      },
    } as never);
    await waitUntil(() => sentNotifications.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sentNotifications).toHaveLength(1);
    expect(
      (sentNotifications[0]!.params as { message: string }).message,
    ).toContain("bad config");

    await handle.dispose();
  });

  it("onShutdown disposes the workspace analyzer; onExit exits 0 only after shutdown", async () => {
    const { connection, handlers } = createFakeConnection();
    const fake = createFakeAdapter({ id: "fake" });
    startLanguageServer({
      connection,
      createWorkspaceAnalyzer: (workspaceRoot) =>
        createWorkspaceAnalyzer({
          workspaceRoot,
          adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
        }),
    });
    await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);
    await (handlers.didOpen as Handler)({
      textDocument: {
        uri: "file:///workspace/A.vue",
        languageId: "vue",
        version: 1,
        text: `<template><p>a</p></template>`,
      },
    } as never);

    await (handlers.shutdown as Handler)();
    expect(fake.disposeCount).toBe(1);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      expect(() => (handlers.exit as Handler)()).toThrow("exit:0");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
