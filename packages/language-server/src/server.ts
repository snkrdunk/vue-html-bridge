// Server wiring (language-server.md §4, §6). Phase 1 scope: initialize,
// UTF-16-only position encoding (ADR-0004), incremental sync, didOpen/
// didChange -> analyze -> publishDiagnostics with the §6.5 stale-result
// suppression pattern. Debounce, didSave/didClose, hover, settings,
// config watching, multi-root, and trust all land in Phase 2 Track 3/4.
import {
  PositionEncodingKind,
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type { WorkspaceAnalyzer } from "@vue-html-bridge/analyzer";
import { sortLspDiagnostics, toLspDiagnostic } from "./diagnostics.js";
import { createDefaultWorkspaceAnalyzer } from "./workspace.js";

export interface ServerLogger {
  error(message: string): void;
}

export interface StartLanguageServerOptions {
  connection: Connection;
  logger?: ServerLogger;
}

export interface LanguageServerHandle {
  dispose(): Promise<void>;
}

const nullLogger: ServerLogger = { error() {} };

interface DocumentState {
  abortController?: AbortController;
}

export function startLanguageServer(
  options: StartLanguageServerOptions,
): LanguageServerHandle {
  const { connection } = options;
  const logger = options.logger ?? nullLogger;
  const documents = new TextDocuments(TextDocument);
  const documentStates = new Map<string, DocumentState>();
  let workspaceAnalyzerPromise: Promise<WorkspaceAnalyzer> | undefined;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    const workspaceRoot = resolveWorkspaceRoot(params);
    // createWorkspaceAnalyzer is async; requests that need it (didOpen/didChange
    // handlers below) await this same promise, so no request races the setup.
    workspaceAnalyzerPromise = createDefaultWorkspaceAnalyzer(workspaceRoot);

    const capabilities: ServerCapabilities = {
      // ADR-0004: Phase 1 supports UTF-16 only, regardless of what the
      // client's general.positionEncodings offers.
      positionEncoding: PositionEncodingKind.UTF16,
      textDocumentSync: TextDocumentSyncKind.Incremental,
    };
    return { capabilities };
  });

  documents.onDidChangeContent((event) => {
    void analyzeAndPublish(event.document);
  });

  async function analyzeAndPublish(document: TextDocument): Promise<void> {
    if (!workspaceAnalyzerPromise) return; // no initialize() yet
    const workspaceAnalyzer = await workspaceAnalyzerPromise;

    const state = documentStates.get(document.uri) ?? {};
    documentStates.set(document.uri, state);
    state.abortController?.abort();
    const controller = new AbortController();
    state.abortController = controller;

    const snapshot = {
      uri: document.uri,
      version: document.version,
      text: document.getText(),
    };

    let result;
    try {
      result = await workspaceAnalyzer.analyze({
        uri: snapshot.uri,
        filename: filePathFromUri(snapshot.uri) ?? snapshot.uri,
        source: snapshot.text,
        documentVersion: snapshot.version,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return; // cancellation is not a diagnostic
      logger.error(`Analysis failed for ${snapshot.uri}: ${String(error)}`);
      return;
    }

    // §6.5: check the signal, the still-current document version, and that
    // this controller is still the live one for this URI — a slow result
    // from a validator with no native cancellation must never be published
    // over a newer one.
    if (controller.signal.aborted) return;
    const current = documents.get(snapshot.uri);
    if (!current || current.version !== snapshot.version) return;
    if (state.abortController !== controller) return;

    const diagnostics = sortLspDiagnostics(
      result.diagnostics.map((diagnostic) =>
        toLspDiagnostic(current, diagnostic),
      ),
    );
    await connection.sendDiagnostics({
      uri: snapshot.uri,
      version: snapshot.version,
      diagnostics: [...diagnostics],
    });
  }

  documents.listen(connection);
  connection.listen();

  return {
    async dispose(): Promise<void> {
      for (const state of documentStates.values())
        state.abortController?.abort();
      await (await workspaceAnalyzerPromise)?.dispose();
    },
  };
}

function resolveWorkspaceRoot(params: InitializeParams): string {
  // rootUri is superseded by workspaceFolders, but older/simpler clients
  // still only send it — kept as a compatibility fallback.
  const folderUri =
    params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
  const path = folderUri ? filePathFromUri(folderUri) : undefined;
  return path ?? process.cwd();
}

function filePathFromUri(uri: string): string | undefined {
  const parsed = URI.parse(uri);
  return parsed.scheme === "file" ? parsed.fsPath : undefined;
}
