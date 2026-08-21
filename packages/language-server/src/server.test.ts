import { describe, expect, it, vi } from "vitest";
import type { Connection } from "vscode-languageserver/node";
import { startLanguageServer } from "./server.js";

type Handler = (...args: unknown[]) => unknown;

function createFakeConnection() {
  const handlers: Record<string, Handler> = {};
  const sentDiagnostics: {
    uri: string;
    version?: number;
    diagnostics: unknown[];
  }[] = [];
  const noop = () => ({ dispose() {} });
  const connection = {
    onInitialize: (handler: Handler) => {
      handlers.initialize = handler;
      return { dispose() {} };
    },
    onInitialized: noop,
    onShutdown: noop,
    onExit: noop,
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
  it("initialize declares UTF-16 position encoding and incremental sync only", async () => {
    const { connection, handlers } = createFakeConnection();
    const handle = startLanguageServer({ connection });
    const result = await handlers.initialize!({
      rootUri: "file:///workspace",
      capabilities: {},
    } as never);
    expect(result).toMatchObject({
      capabilities: { positionEncoding: "utf-16", textDocumentSync: 2 },
    });
    expect(
      (result as { capabilities: { hoverProvider?: unknown } }).capabilities
        .hoverProvider,
    ).toBeUndefined();
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
});
