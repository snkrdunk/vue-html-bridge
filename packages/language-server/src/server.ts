// Server wiring (language-server.md §4, §6, §7.3, §8, §9, §12): debounce,
// didSave, hover, session-failure notice dedup, graceful shutdown,
// settings resolution, multi-root workspace management, config-file
// watching, and untrusted-workspace handling for the built-in adapter.
// External-adapter loading (§10.2) is not wired in yet — that lands once
// @vue-html-bridge/adapter-loader is integrated as a follow-up.
import { relative } from "node:path";
import { minimatch } from "minimatch";
import {
  DidChangeWatchedFilesNotification,
  MessageType,
  PositionEncodingKind,
  ShowMessageNotification,
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type Disposable,
  type FileEvent,
  type FileSystemWatcher,
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
import {
  createNodeFileSystem,
  decomposeSettings,
  type HostSettings,
} from "@vue-html-bridge/settings";
import {
  buildWatchRegistrationPlan,
  matchConfigChange,
  watchPlansEqual,
  type WatchRegistrationPlan,
} from "./config/watcher.js";
import type { ConfigurationClient } from "./config/sources.js";
import { resolveWorkspaceSettings } from "./config/sources.js";
import { sortLspDiagnostics, toLspDiagnostic } from "./diagnostics.js";
import { buildHover, findHoverDiagnostic } from "./hover.js";
import {
  createPositionIndex,
  negotiatePositionEncoding,
  toSourceOffset,
  type PositionIndex,
} from "./positions.js";
import {
  createWorkspaceManager,
  type WorkspaceManager,
} from "./workspace/manager.js";
import type { WorkspaceSession } from "./workspace/session.js";

export interface ServerLogger {
  error(message: string): void;
}

/** language-server.md §4.2. */
export interface VueHtmlBridgeInitializationOptions {
  workspaceTrusted?: boolean;
  settings?: unknown;
}

export interface StartLanguageServerOptions {
  connection: Connection;
  logger?: ServerLogger;
  /**
   * Overrides how the workspace analyzer is built for a given workspace
   * root, entirely bypassing settings resolution/multi-root/config
   * watching/trust. Exposed for tests that need a specific adapter/session
   * outcome (e.g. a forced Markuplint session failure, or a fake adapter)
   * without real filesystem setup; hosts normally omit this.
   */
  createWorkspaceAnalyzer?: (
    workspaceRoot: string,
  ) => Promise<WorkspaceAnalyzer>;
}

export interface LanguageServerHandle {
  dispose(): Promise<void>;
}

const nullLogger: ServerLogger = { error() {} };

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
  const documents = new TextDocuments(TextDocument);
  const documentStates = new Map<string, DocumentState>();
  // Keyed by `${sessionFolderRoot}\0${code}` — a session-level failure
  // notice is deduped per workspace, but two different workspace folders
  // each hitting the same failure kind get their own notice.
  const notifiedSessionFailures = new Set<string>();
  let encoding: PositionEncodingKind = PositionEncodingKind.UTF16;
  let shuttingDown = false;
  let disposed = false;

  // Legacy/test escape hatch: a single analyzer, no settings/multi-root/
  // config-watching/trust machinery at all.
  let legacyAnalyzerPromise: Promise<WorkspaceAnalyzer> | undefined;
  // Real path: multi-root workspace management (§9.1) and config watching (§9.3).
  let manager: WorkspaceManager | undefined;
  // Resolves once every workspace folder present at initialize() time has a
  // session (settings resolved, including any workspace/configuration round
  // trip). A didOpen that races ahead of this must wait for it rather than
  // falling through to the untrusted single-file restricted session, which
  // would silently pick default settings instead of the real folder's.
  let initialSetupPromise: Promise<void> = Promise.resolve();
  let watchRegistration:
    { plan: WatchRegistrationPlan; disposable: Disposable } | undefined;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    encoding = negotiatePositionEncoding(
      params.capabilities.general?.positionEncodings,
    );

    if (options.createWorkspaceAnalyzer) {
      legacyAnalyzerPromise = options.createWorkspaceAnalyzer(
        resolveWorkspaceRoot(params),
      );
    } else {
      const initializationOptions = (params.initializationOptions ??
        {}) as VueHtmlBridgeInitializationOptions;
      const workspaceTrusted = initializationOptions.workspaceTrusted ?? false;
      const supportsWorkspaceConfiguration = Boolean(
        params.capabilities.workspace?.configuration,
      );
      const configurationClient: ConfigurationClient = {
        getConfiguration: (section) =>
          connection.workspace.getConfiguration(section),
      };
      manager = createWorkspaceManager({
        workspaceTrusted,
        resolveSettingsForFolder: async (folderRoot) => {
          const resolved = await resolveWorkspaceSettings({
            workspaceRoot: folderRoot,
            initializationSettings: initializationOptions.settings as never,
            supportsWorkspaceConfiguration,
            configurationClient,
            fileSystem: createNodeFileSystem(),
          });
          reportSettingsIssuesOnce(folderRoot, resolved.issues);
          return resolved.settings;
        },
      });
      const initialFolders = resolveInitialWorkspaceFolders(params);
      initialSetupPromise = Promise.all(
        initialFolders.map((folderUri) => manager!.addFolder(folderUri)),
      )
        .then(() => refreshWatchRegistrations())
        .catch((error: unknown) => {
          logger.error(
            `Failed to initialize workspace folders: ${String(error)}`,
          );
        });

      // Only register for change notifications when the client actually
      // declared support — vscode-languageserver/node throws synchronously
      // otherwise (real LSP client capability negotiation, not just a test
      // artifact).
      if (params.capabilities.workspace?.workspaceFolders) {
        connection.workspace.onDidChangeWorkspaceFolders((event) => {
          void (async () => {
            for (const folder of event.removed) {
              await manager!.removeFolder(folder.uri);
            }
            for (const folder of event.added) {
              await manager!.addFolder(folder.uri);
            }
            await refreshWatchRegistrations();
          })();
        });
      }
    }

    const capabilities: ServerCapabilities = {
      positionEncoding: encoding,
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      workspace: options.createWorkspaceAnalyzer
        ? undefined
        : {
            workspaceFolders: {
              supported: true,
              changeNotifications: true,
            },
          },
    };
    return { capabilities };
  });

  connection.onDidChangeConfiguration(() => {
    if (!manager) return; // legacy mode
    void reconfigureAllSessions();
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!manager) return; // legacy mode
    void handleWatchedFilesChanged(params.changes);
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

  /** §6.1/§6.2/§6.3: 0ms for didOpen/didSave, settings-driven `debounceMs` for didChange (legacy mode: fixed `DEBOUNCE_MS`). */
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
    void handleDocumentTrigger(event.document, "open");
  });

  documents.onDidChangeContent((event) => {
    if (openedAtVersion.get(event.document.uri) === event.document.version) {
      return;
    }
    void handleDocumentTrigger(event.document, "change");
  });

  documents.onDidSave((event) => {
    void handleDocumentTrigger(event.document, "save");
  });

  /**
   * §9.2 host-fields routing: `enabled` and `include`/`exclude` gate whether
   * a document is automatically analyzed at all; `validateOnChange`/
   * `validateOnSave` gate the respective trigger kind specifically;
   * `debounceMs` only applies to "change" (§6.1–§6.3: open/save always
   * schedule at 0ms once past the enabled/include-exclude gate). The legacy
   * `createWorkspaceAnalyzer` escape hatch bypasses settings entirely,
   * matching its pre-existing fixed-`DEBOUNCE_MS` behavior.
   */
  async function handleDocumentTrigger(
    document: TextDocument,
    kind: "open" | "change" | "save",
  ): Promise<void> {
    const gate = await resolveDocumentGate(document.uri);
    if (!gate.proceed) return;
    if (kind === "change" && !gate.validateOnChange) return;
    if (kind === "save" && !gate.validateOnSave) return;
    scheduleAnalysis(document, kind === "change" ? gate.debounceMs : 0);
  }

  documents.onDidClose((event) => {
    const uri = event.document.uri;
    openedAtVersion.delete(uri);
    const state = documentStates.get(uri);
    if (state?.debounceTimer) clearTimeout(state.debounceTimer);
    state?.abortController?.abort();
    documentStates.delete(uri);
    void connection.sendDiagnostics({ uri, diagnostics: [] });
  });

  async function resolveSessionForDocument(
    uri: string,
  ): Promise<{ analyzer: WorkspaceAnalyzer; session?: WorkspaceSession }> {
    if (legacyAnalyzerPromise) {
      return { analyzer: await legacyAnalyzerPromise };
    }
    if (!manager) throw new Error("startLanguageServer: no initialize() yet");
    await initialSetupPromise;
    const session = await manager.resolveForUri(uri);
    return { analyzer: session.analyzer, session };
  }

  interface DocumentGate {
    /** `enabled && include/exclude` — whether to automatically analyze at all. */
    proceed: boolean;
    debounceMs: number;
    validateOnChange: boolean;
    validateOnSave: boolean;
  }

  async function resolveDocumentGate(uri: string): Promise<DocumentGate> {
    if (legacyAnalyzerPromise) {
      // Legacy escape hatch bypasses settings entirely — its pre-existing behavior.
      return {
        proceed: true,
        debounceMs: DEBOUNCE_MS,
        validateOnChange: true,
        validateOnSave: true,
      };
    }
    if (!manager) {
      return {
        proceed: false,
        debounceMs: DEBOUNCE_MS,
        validateOnChange: true,
        validateOnSave: true,
      };
    }
    await initialSetupPromise;
    const session = await manager.resolveForUri(uri);
    const host = decomposeSettings(session.settings).host;
    return {
      proceed: proceedGate(session, uri),
      debounceMs: host.debounceMs,
      validateOnChange: host.validateOnChange,
      validateOnSave: host.validateOnSave,
    };
  }

  /** `enabled` + `include`/`exclude` for a session already resolved (reused by the config-reactive re-analysis loops, which don't need the full gate). */
  function proceedGate(session: WorkspaceSession, uri: string): boolean {
    const host = decomposeSettings(session.settings).host;
    if (!host.enabled) return false;
    const absolutePath = filePathFromUri(uri);
    if (absolutePath === undefined) return true; // can't glob-match; don't silently exclude
    return matchesIncludeExclude(host, session.folderRoot, absolutePath);
  }

  async function analyzeAndPublish(
    document: TextDocument,
    state: DocumentState,
  ): Promise<void> {
    if (!legacyAnalyzerPromise && !manager) return; // no initialize() yet

    const controller = new AbortController();
    state.abortController = controller;

    const snapshot = {
      uri: document.uri,
      version: document.version,
      text: document.getText(),
    };

    let result;
    let session: WorkspaceSession | undefined;
    try {
      const resolved = await resolveSessionForDocument(snapshot.uri);
      session = resolved.session;
      result = await resolved.analyzer.analyze({
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

    notifySessionFailuresOnce(session?.folderRoot ?? "", result.diagnostics);

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

    // §9.3: refresh after each analysis — validate() may have discovered a
    // nearer config or another resolved dependency.
    if (manager) await refreshWatchRegistrations();
  }

  // §7.3: one window notice per workspace per session-level failure, not
  // one per document per analyze() call.
  function notifySessionFailuresOnce(
    workspaceKey: string,
    diagnostics: readonly SourceDiagnostic[],
  ): void {
    for (const diagnostic of diagnostics) {
      if (diagnostic.origin !== "adapter") continue;
      if (!SESSION_FAILURE_CODE.test(diagnostic.code)) continue;
      const key = `${workspaceKey}\0${diagnostic.code}`;
      if (notifiedSessionFailures.has(key)) continue;
      notifiedSessionFailures.add(key);
      // A plain notification (§7.3: "reported through window/showMessage"),
      // not showWarningMessage()'s window/showMessageRequest — there is no
      // action for the user to choose here.
      void connection.sendNotification(ShowMessageNotification.type, {
        type: MessageType.Warning,
        message: diagnostic.message,
      });
    }
  }

  function reportSettingsIssuesOnce(
    folderRoot: string,
    issues: readonly { severity: string; message: string }[],
  ): void {
    for (const issue of issues) {
      const key = `${folderRoot}\0settings\0${issue.message}`;
      if (notifiedSessionFailures.has(key)) continue;
      notifiedSessionFailures.add(key);
      void connection.sendNotification(ShowMessageNotification.type, {
        type:
          issue.severity === "error" ? MessageType.Error : MessageType.Warning,
        message: issue.message,
      });
    }
  }

  /** §9.3: workspace/didChangeConfiguration — re-fetch, reconfigure, re-analyze open docs. */
  async function reconfigureAllSessions(): Promise<void> {
    if (!manager) return;
    const reconfigured = await manager.reconfigureFolders();
    if (reconfigured.length === 0) return;
    await refreshWatchRegistrations();
    const reconfiguredSet = new Set(reconfigured);
    for (const document of documents.all()) {
      const session = await manager.resolveForUri(document.uri);
      if (reconfiguredSet.has(session) && proceedGate(session, document.uri)) {
        scheduleAnalysis(document, 0);
      }
    }
  }

  async function handleWatchedFilesChanged(
    changes: readonly FileEvent[],
  ): Promise<void> {
    if (!manager) return;
    const sessions = manager.sessions();
    const affected = new Set<WorkspaceSession>();
    for (const change of changes) {
      const absolutePath = filePathFromUri(change.uri);
      if (!absolutePath) continue;
      const match = matchConfigChange(sessions, absolutePath);
      if (!match) continue;
      await match.session.reconfigure(match.session.settings, {
        invalidateAdapters: match.adapterIds,
      });
      affected.add(match.session);
    }
    if (affected.size === 0) return;
    await refreshWatchRegistrations();
    for (const document of documents.all()) {
      const session = await manager.resolveForUri(document.uri);
      if (affected.has(session) && proceedGate(session, document.uri)) {
        scheduleAnalysis(document, 0);
      }
    }
  }

  /** §9.3: after session creation/reconfiguration and after each analysis. */
  async function refreshWatchRegistrations(): Promise<void> {
    if (!manager) return;
    for (const session of manager.sessions()) {
      session.lastWatchTargets = session.analyzer.getConfigWatchTargets();
    }
    const plan = buildWatchRegistrationPlan(manager.sessions());
    if (watchRegistration && watchPlansEqual(watchRegistration.plan, plan)) {
      return;
    }
    const previous = watchRegistration;
    if (
      plan.patternGlobs.length === 0 &&
      plan.concreteAbsolutePaths.length === 0
    ) {
      watchRegistration = undefined;
    } else {
      try {
        const watchers: FileSystemWatcher[] = [
          ...plan.patternGlobs.map((globPattern) => ({ globPattern })),
          ...plan.concreteAbsolutePaths.map((globPattern) => ({ globPattern })),
        ];
        const disposable = await connection.client.register(
          DidChangeWatchedFilesNotification.type,
          { watchers },
        );
        watchRegistration = { plan, disposable };
      } catch (error) {
        logger.error(
          `Failed to register config file watchers: ${String(error)}`,
        );
        watchRegistration = undefined;
      }
    }
    previous?.disposable.dispose();
  }

  async function disposeServer(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const state of documentStates.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.abortController?.abort();
    }
    watchRegistration?.disposable.dispose();
    if (legacyAnalyzerPromise) await (await legacyAnalyzerPromise).dispose();
    if (manager) await manager.disposeAll();
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

function resolveInitialWorkspaceFolders(
  params: InitializeParams,
): readonly string[] {
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    return params.workspaceFolders.map((folder) => folder.uri);
  }
  if (params.rootUri) return [params.rootUri];
  return [];
}

function filePathFromUri(uri: string): string | undefined {
  const parsed = URI.parse(uri);
  return parsed.scheme === "file" ? parsed.fsPath : undefined;
}

/** §9.2/§4.2: `include`/`exclude` are matched against the path relative to the owning session's folder root — host-neutral, so they still apply even in an untrusted workspace. */
function matchesIncludeExclude(
  host: HostSettings,
  folderRoot: string,
  absolutePath: string,
): boolean {
  const relativePath = relative(folderRoot, absolutePath);
  const included = host.include.some((pattern) =>
    minimatch(relativePath, pattern, { dot: true }),
  );
  if (!included) return false;
  return !host.exclude.some((pattern) =>
    minimatch(relativePath, pattern, { dot: true }),
  );
}
