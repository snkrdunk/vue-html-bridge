// Server wiring (language-server.md §4, §6, §7.3, §8, §12). Settings,
// config watching, multi-root, and external-adapter trust still land in
// Phase 2 Track 4 / Phase 3 — this covers "interaction quality": debounce,
// didSave, hover, session-failure notice dedup, and graceful shutdown.
import {
  MessageType,
  PositionEncodingKind,
  ShowMessageNotification,
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type Hover,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import type {
  SourceDiagnostic,
  WorkspaceAnalyzer,
} from "@vue-html-bridge/analyzer";
import { sortLspDiagnostics, toLspDiagnostic } from "./diagnostics.js";
import { buildHover, findHoverDiagnostic } from "./hover.js";
import {
  createPositionIndex,
  negotiatePositionEncoding,
  toSourceOffset,
  type PositionIndex,
} from "./positions.js";
import { createDefaultWorkspaceAnalyzer } from "./workspace.js";

export interface ServerLogger {
  error(message: string): void;
}

export interface StartLanguageServerOptions {
  connection: Connection;
  logger?: ServerLogger;
  /**
   * Overrides how the (single, hardcoded-Markuplint, Phase 1) workspace
   * analyzer is built for a given workspace root. Exposed for tests that
   * need a specific adapter/session outcome (e.g. a forced Markuplint
   * session failure) without real filesystem setup; hosts normally omit
   * this and get createDefaultWorkspaceAnalyzer.
   */
  createWorkspaceAnalyzer?: (
    workspaceRoot: string,
  ) => Promise<WorkspaceAnalyzer>;
}

export interface LanguageServerHandle {
  dispose(): Promise<void>;
}

const nullLogger: ServerLogger = { error() {} };

// §3.1's hardcoded defaults, until Phase 2 Track 4 wires real settings
// resolution through here.
const DEBOUNCE_MS = 200;

const SESSION_FAILURE_CODE =
  /^adapter\/[^/]+\/(configuration-error|validator-unavailable)$/;

interface DocumentState {
  abortController?: AbortController;
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** §8: cached alongside the last publish, for hover hit-testing. */
  hoverCache?: {
    version: number;
    diagnostics: readonly SourceDiagnostic[];
    positionIndex: PositionIndex;
  };
}

export function startLanguageServer(
  options: StartLanguageServerOptions,
): LanguageServerHandle {
  const { connection } = options;
  const logger = options.logger ?? nullLogger;
  const buildWorkspaceAnalyzer =
    options.createWorkspaceAnalyzer ?? createDefaultWorkspaceAnalyzer;
  const documents = new TextDocuments(TextDocument);
  const documentStates = new Map<string, DocumentState>();
  const notifiedSessionFailures = new Set<string>();
  let workspaceAnalyzerPromise: Promise<WorkspaceAnalyzer> | undefined;
  let encoding: PositionEncodingKind = PositionEncodingKind.UTF16;
  let shuttingDown = false;
  let disposed = false;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    const workspaceRoot = resolveWorkspaceRoot(params);
    // createWorkspaceAnalyzer is async; requests that need it (analyzeAndPublish
    // below) await this same promise, so no request races the setup.
    workspaceAnalyzerPromise = buildWorkspaceAnalyzer(workspaceRoot);
    encoding = negotiatePositionEncoding(
      params.capabilities.general?.positionEncodings,
    );

    const capabilities: ServerCapabilities = {
      positionEncoding: encoding,
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
    };
    return { capabilities };
  });

  connection.onHover((params: HoverParams): Hover | null => {
    const state = documentStates.get(params.textDocument.uri);
    const cache = state?.hoverCache;
    if (!cache) return null;
    const offset = toSourceOffset(
      cache.positionIndex,
      encoding,
      params.position,
    );
    const diagnostic = findHoverDiagnostic(cache.diagnostics, offset);
    if (!diagnostic) return null;
    return buildHover(cache.positionIndex, encoding, diagnostic);
  });

  connection.onShutdown(async () => {
    shuttingDown = true;
    await disposeServer();
  });
  connection.onExit(() => {
    process.exit(shuttingDown ? 0 : 1);
  });

  function stateFor(uri: string): DocumentState {
    const existing = documentStates.get(uri);
    if (existing) return existing;
    const created: DocumentState = {};
    documentStates.set(uri, created);
    return created;
  }

  /** §6.1/§6.2/§6.3: 0ms for didOpen/didSave, DEBOUNCE_MS for didChange. */
  function scheduleAnalysis(document: TextDocument, debounceMs: number): void {
    const state = stateFor(document.uri);
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = undefined;
    }
    // §6.2: discard any pending timer AND abort analysis already in flight.
    state.abortController?.abort();
    state.abortController = undefined;
    if (debounceMs <= 0) {
      void analyzeAndPublish(document, state);
    } else {
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = undefined;
        void analyzeAndPublish(document, state);
      }, debounceMs);
    }
  }

  // onDidOpen and onDidChangeContent both fire for a document's first
  // version (opening is itself a "content change" in TextDocuments), so
  // onDidChangeContent skips whatever version onDidOpen already scheduled —
  // this holds regardless of which handler happens to run first.
  const openedAtVersion = new Map<string, number>();

  documents.onDidOpen((event) => {
    openedAtVersion.set(event.document.uri, event.document.version);
    scheduleAnalysis(event.document, 0);
  });

  documents.onDidChangeContent((event) => {
    if (openedAtVersion.get(event.document.uri) === event.document.version) {
      return;
    }
    scheduleAnalysis(event.document, DEBOUNCE_MS);
  });

  documents.onDidSave((event) => {
    // §6.3: re-analyze immediately, bypassing the debounce.
    scheduleAnalysis(event.document, 0);
  });

  documents.onDidClose((event) => {
    const uri = event.document.uri;
    openedAtVersion.delete(uri);
    const state = documentStates.get(uri);
    if (state?.debounceTimer) clearTimeout(state.debounceTimer);
    state?.abortController?.abort();
    documentStates.delete(uri);
    void connection.sendDiagnostics({ uri, diagnostics: [] });
  });

  async function analyzeAndPublish(
    document: TextDocument,
    state: DocumentState,
  ): Promise<void> {
    if (!workspaceAnalyzerPromise) return; // no initialize() yet
    const workspaceAnalyzer = await workspaceAnalyzerPromise;

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

    notifySessionFailuresOnce(result.diagnostics);

    const positionIndex = createPositionIndex(snapshot.text);
    state.hoverCache = {
      version: snapshot.version,
      diagnostics: result.diagnostics,
      positionIndex,
    };

    const diagnostics = sortLspDiagnostics(
      result.diagnostics.map((diagnostic) =>
        toLspDiagnostic(snapshot.uri, positionIndex, encoding, diagnostic),
      ),
    );
    await connection.sendDiagnostics({
      uri: snapshot.uri,
      version: snapshot.version,
      diagnostics: [...diagnostics],
    });
  }

  // §7.3: one window notice per workspace per session-level failure, not
  // one per document per analyze() call.
  function notifySessionFailuresOnce(
    diagnostics: readonly SourceDiagnostic[],
  ): void {
    for (const diagnostic of diagnostics) {
      if (diagnostic.origin !== "adapter") continue;
      if (!SESSION_FAILURE_CODE.test(diagnostic.code)) continue;
      if (notifiedSessionFailures.has(diagnostic.code)) continue;
      notifiedSessionFailures.add(diagnostic.code);
      // A plain notification (§7.3: "reported through window/showMessage"),
      // not showWarningMessage()'s window/showMessageRequest — there is no
      // action for the user to choose here.
      void connection.sendNotification(ShowMessageNotification.type, {
        type: MessageType.Warning,
        message: diagnostic.message,
      });
    }
  }

  async function disposeServer(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const state of documentStates.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.abortController?.abort();
    }
    await (await workspaceAnalyzerPromise)?.dispose();
  }

  documents.listen(connection);
  connection.listen();

  return { dispose: disposeServer };
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
