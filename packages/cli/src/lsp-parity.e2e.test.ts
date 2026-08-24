// CLI/LSP parity E2E (cli.md §9 item 14; monorepo.md §12.2; release
// checklist, implementation-plan.md §6 task 7): both hosts, given the same
// fixture file on disk, the same resolved settings, and the same trust
// policy, must report the same source diagnostics (code, range, severity,
// adapterId). A restricted-mode run repeats the same assertion under
// `--untrusted` / an untrusted LSP workspace.
//
// @vue-html-bridge/language-server is a devDependency here only for this
// test (see check-dependency-graph.mjs's comment on the CLI's expected
// deps) — nothing in the published CLI depends on it, and the CLI's own
// production code never imports it.
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createConnection, type Connection } from "vscode-languageserver/node";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";
import {
  startLanguageServer,
  type LanguageServerHandle,
} from "@vue-html-bridge/language-server";
import { runVueHtmlBridgeCli } from "./cli.js";
import type { CliNdjsonFile, CliNdjsonRecord } from "./output/ndjson.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../examples/playground/logged-in-aria-controls.vue",
    import.meta.url,
  ),
);
const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The subset of a diagnostic comparable across both hosts' own output shapes. */
interface ComparableDiagnostic {
  code: string;
  severity: string;
  adapterId: string | undefined;
  startLine: number; // 0-based
  startColumn: number; // 0-based, UTF-16 code units
}

function bySourcePosition(
  a: ComparableDiagnostic,
  b: ComparableDiagnostic,
): number {
  return (
    a.startLine - b.startLine ||
    a.startColumn - b.startColumn ||
    a.code.localeCompare(b.code)
  );
}

function lspSeverityName(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "unknown";
  }
}

interface LspDiagnostic {
  code?: string;
  severity?: number;
  source?: string;
  range: { start: { line: number; character: number } };
}

async function runLanguageServer(
  workspaceTrusted: boolean,
): Promise<readonly ComparableDiagnostic[]> {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const serverConnection: Connection = createConnection(
    clientToServer,
    serverToClient,
  );
  const client: MessageConnection = createMessageConnection(
    serverToClient,
    clientToServer,
  );
  const notifications: { method: string; params: unknown }[] = [];
  client.onNotification((method: string, params: unknown) => {
    notifications.push({ method, params });
  });
  client.onRequest("client/registerCapability", () => null);
  client.onRequest("client/unregisterCapability", () => null);
  client.listen();

  const handle: LanguageServerHandle = startLanguageServer({
    connection: serverConnection,
  });

  try {
    await client.sendRequest("initialize", {
      processId: null,
      rootUri: URI.file(WORKSPACE_ROOT).toString(),
      capabilities: {},
      initializationOptions: { workspaceTrusted },
    });
    await client.sendNotification("initialized", {});

    // Reads the exact same bytes the CLI will read from the exact same
    // path — "disk file == LSP buffer" (cli.md §9 item 14).
    const source = await readFile(FIXTURE_PATH, "utf8");
    const uri = URI.file(FIXTURE_PATH).toString();
    await client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "vue", version: 1, text: source },
    });

    const deadline = Date.now() + 5000;
    for (;;) {
      const match = notifications.find(
        (n) =>
          n.method === "textDocument/publishDiagnostics" &&
          (n.params as { uri: string }).uri === uri,
      );
      if (match) {
        const params = match.params as {
          diagnostics: readonly LspDiagnostic[];
        };
        return params.diagnostics
          .map((d): ComparableDiagnostic => ({
            code: String(d.code),
            severity: lspSeverityName(d.severity),
            adapterId: d.source?.startsWith("vue-html-bridge/")
              ? d.source.slice("vue-html-bridge/".length)
              : undefined,
            startLine: d.range.start.line,
            startColumn: d.range.start.character,
          }))
          .sort(bySourcePosition);
      }
      if (Date.now() > deadline) {
        throw new Error(
          "runLanguageServer: timed out waiting for publishDiagnostics",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    await handle.dispose();
    client.dispose();
  }
}

async function runCliOnFixture(
  untrusted: boolean,
): Promise<readonly ComparableDiagnostic[]> {
  let stdout = "";
  const relativeFixturePath = relative(WORKSPACE_ROOT, FIXTURE_PATH);
  const argv = [
    "--workspace-root",
    WORKSPACE_ROOT,
    "--format",
    "ndjson",
    ...(untrusted ? ["--untrusted"] : []),
    relativeFixturePath,
  ];
  const result = await runVueHtmlBridgeCli({
    argv,
    cwd: WORKSPACE_ROOT,
    writeStdout: (chunk) => {
      stdout += chunk;
    },
    writeStderr: () => {},
    signal: new AbortController().signal,
    version: "0.0.0-test",
  });
  expect(result.interrupted).toBe(false);

  const records: CliNdjsonRecord[] = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CliNdjsonRecord);
  const fileRecord = records.find(
    (record): record is CliNdjsonFile => record.type === "file",
  );
  expect(fileRecord).toBeDefined();

  return fileRecord!.diagnostics
    .map((d): ComparableDiagnostic => ({
      code: d.code,
      severity: d.severity,
      adapterId: d.adapterId,
      // CLI positions are 1-based (cli.md §7); LSP positions are 0-based.
      startLine: d.position.startLine - 1,
      startColumn: d.position.startColumn - 1,
    }))
    .sort(bySourcePosition);
}

describe("CLI/LSP parity E2E (cli.md §9 item 14)", () => {
  it("reports the same source diagnostics as the language server on the same fixture, trusted", async () => {
    const [lsDiagnostics, cliDiagnostics] = await Promise.all([
      runLanguageServer(true),
      runCliOnFixture(false),
    ]);

    expect(lsDiagnostics.length).toBeGreaterThan(0);
    expect(cliDiagnostics).toEqual(lsDiagnostics);
    expect(
      lsDiagnostics.some((d) => d.code === "no-refer-to-non-existent-id"),
    ).toBe(true);
  });

  it("reports the same source diagnostics under equalized restricted trust (--untrusted / an untrusted LSP workspace)", async () => {
    const [lsDiagnostics, cliDiagnostics] = await Promise.all([
      runLanguageServer(false),
      runCliOnFixture(true),
    ]);

    expect(lsDiagnostics.length).toBeGreaterThan(0);
    expect(cliDiagnostics).toEqual(lsDiagnostics);
    // This fixture's violation comes from Markuplint's bundled default
    // ruleset, not from any workspace-discovered config, so it still fires
    // identically while restricted — proving the restriction itself (no
    // external adapters, bundled Markuplint defaults) was equalized
    // correctly between the two hosts, not just that both produced nothing.
    expect(
      lsDiagnostics.some((d) => d.code === "no-refer-to-non-existent-id"),
    ).toBe(true);
  });
});
