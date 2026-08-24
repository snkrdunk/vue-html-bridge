// Multi-root workspace management (language-server.md §9.1): one session
// per workspace folder, longest-matching-prefix URI routing, and a
// restricted default session for a single file outside any folder.
import { dirname } from "node:path";
import { URI } from "vscode-uri";
import type { AnalyzerLogger } from "@vue-html-bridge/analyzer";
import {
  resolveSettings,
  type ResolvedVueHtmlBridgeSettings,
} from "@vue-html-bridge/settings";
import { createWorkspaceSession, type WorkspaceSession } from "./session.js";

export interface WorkspaceManagerOptions {
  logger?: AnalyzerLogger;
  workspaceTrusted: boolean;
  /** Resolves settings for one real workspace folder (§9.2). */
  resolveSettingsForFolder: (
    folderRoot: string,
  ) => Promise<ResolvedVueHtmlBridgeSettings>;
}

export interface WorkspaceManager {
  addFolder(folderUri: string): Promise<WorkspaceSession>;
  removeFolder(folderUri: string): Promise<void>;
  /** Longest-matching-prefix routing; falls back to a restricted per-directory session. */
  resolveForUri(documentUri: string): Promise<WorkspaceSession>;
  /**
   * §9.3 `workspace/didChangeConfiguration`: re-resolves settings for every
   * *real* folder (never the restricted single-file sessions, which don't
   * participate in settings resolution) and reconfigures each in place.
   * Returns the sessions that were reconfigured, for re-analyzing their
   * open documents.
   */
  reconfigureFolders(): Promise<readonly WorkspaceSession[]>;
  sessions(): readonly WorkspaceSession[];
  disposeAll(): Promise<void>;
}

function normalizeFolderKey(fsPath: string): string {
  return fsPath.endsWith("/") ? fsPath : `${fsPath}/`;
}

export function createWorkspaceManager(
  options: WorkspaceManagerOptions,
): WorkspaceManager {
  const folders = new Map<string, WorkspaceSession>(); // key: normalized fsPath
  const restricted = new Map<string, WorkspaceSession>(); // key: containing directory

  async function addFolder(folderUri: string): Promise<WorkspaceSession> {
    const root = URI.parse(folderUri).fsPath;
    const key = normalizeFolderKey(root);
    const existing = folders.get(key);
    if (existing) return existing;
    const settings = await options.resolveSettingsForFolder(root);
    const session = await createWorkspaceSession({
      folderRoot: root,
      settings,
      workspaceTrusted: options.workspaceTrusted,
      logger: options.logger,
    });
    folders.set(key, session);
    return session;
  }

  async function removeFolder(folderUri: string): Promise<void> {
    const root = URI.parse(folderUri).fsPath;
    const key = normalizeFolderKey(root);
    const session = folders.get(key);
    if (!session) return;
    folders.delete(key);
    await session.dispose();
  }

  function findByPrefix(fsPath: string): WorkspaceSession | undefined {
    let best: WorkspaceSession | undefined;
    let bestLength = -1;
    for (const [key, session] of folders) {
      if ((fsPath + "/").startsWith(key) && key.length > bestLength) {
        best = session;
        bestLength = key.length;
      }
    }
    return best;
  }

  async function resolveForUri(documentUri: string): Promise<WorkspaceSession> {
    const fsPath = URI.parse(documentUri).fsPath;
    const matched = findByPrefix(fsPath);
    if (matched) return matched;

    // §9.1: a file outside any folder gets a restricted default session
    // (no external adapters, bundled-safe built-in defaults, its own
    // unshared TypeAnalysisContext/cache) — keyed by containing directory
    // so files in the same loose directory share one session.
    const directory = dirname(fsPath);
    const existing = restricted.get(directory);
    if (existing) return existing;
    const { settings } = resolveSettings([]);
    const session = await createWorkspaceSession({
      folderRoot: directory,
      settings,
      workspaceTrusted: false,
      logger: options.logger,
    });
    restricted.set(directory, session);
    return session;
  }

  async function reconfigureFolders(): Promise<readonly WorkspaceSession[]> {
    const targets = [...folders.values()];
    await Promise.all(
      targets.map(async (session) => {
        const settings = await options.resolveSettingsForFolder(
          session.folderRoot,
        );
        await session.reconfigure(settings);
      }),
    );
    return targets;
  }

  function sessions(): readonly WorkspaceSession[] {
    return [...folders.values(), ...restricted.values()];
  }

  async function disposeAll(): Promise<void> {
    const all = sessions();
    folders.clear();
    restricted.clear();
    await Promise.all(all.map((session) => session.dispose()));
  }

  return {
    addFolder,
    removeFolder,
    resolveForUri,
    reconfigureFolders,
    sessions,
    disposeAll,
  };
}
