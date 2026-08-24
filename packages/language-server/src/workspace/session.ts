// One workspace folder's session (language-server.md §9.1): owns its
// analyzer, TypeAnalysisContext, resolved settings, and the config
// watch-target snapshot used for diffing registrations (§9.3).
import {
  createTypeAnalysisContext,
  createWorkspaceAnalyzer,
  type AnalyzerConfigWatchTarget,
  type AnalyzerLogger,
  type ConfiguredAdapter,
  type TypeAnalysisContext,
  type WorkspaceAnalyzer,
} from "@vue-html-bridge/analyzer";
import {
  decomposeSettings,
  type ResolvedVueHtmlBridgeSettings,
} from "@vue-html-bridge/settings";
import { buildConfiguredAdapters } from "../adapters/trust.js";

export interface WorkspaceSession {
  readonly folderRoot: string;
  readonly analyzer: WorkspaceAnalyzer;
  readonly typeContext: TypeAnalysisContext;
  settings: ResolvedVueHtmlBridgeSettings;
  workspaceTrusted: boolean;
  /** The adapter list currently passed to the analyzer — the language
   *  server's own record, since WorkspaceAnalyzer doesn't expose it. Used
   *  to know each active adapter's `configFilePatterns` (§9.3). */
  configuredAdapters: readonly ConfiguredAdapter[];
  /** Last snapshot used to compute watcher registrations (§9.3). */
  lastWatchTargets: readonly AnalyzerConfigWatchTarget[];
  reconfigure(
    settings: ResolvedVueHtmlBridgeSettings,
    options?: { invalidateAdapters?: readonly string[] },
  ): Promise<void>;
  dispose(): Promise<void>;
}

export async function createWorkspaceSession(options: {
  folderRoot: string;
  settings: ResolvedVueHtmlBridgeSettings;
  workspaceTrusted: boolean;
  logger?: AnalyzerLogger;
}): Promise<WorkspaceSession> {
  const typeContext = createTypeAnalysisContext();
  const decomposed = decomposeSettings(options.settings);
  const initialAdapters = buildConfiguredAdapters(
    decomposed.validators,
    options.workspaceTrusted,
  );
  const analyzer = await createWorkspaceAnalyzer({
    workspaceRoot: options.folderRoot,
    adapters: initialAdapters,
    generateOptions: decomposed.generateOptions,
    maxConcurrency: decomposed.analyzer.maxConcurrency,
    typeContext,
    logger: options.logger,
  });

  const session: WorkspaceSession = {
    folderRoot: options.folderRoot,
    analyzer,
    typeContext,
    settings: options.settings,
    workspaceTrusted: options.workspaceTrusted,
    configuredAdapters: initialAdapters,
    lastWatchTargets: [],
    async reconfigure(nextSettings, reconfigureOptions) {
      const nextDecomposed = decomposeSettings(nextSettings);
      const nextAdapters = buildConfiguredAdapters(
        nextDecomposed.validators,
        session.workspaceTrusted,
      );
      await analyzer.reconfigure({
        adapters: nextAdapters,
        generateOptions: nextDecomposed.generateOptions,
        maxConcurrency: nextDecomposed.analyzer.maxConcurrency,
        invalidateAdapters: reconfigureOptions?.invalidateAdapters,
      });
      session.settings = nextSettings;
      session.configuredAdapters = nextAdapters;
    },
    async dispose() {
      await analyzer.dispose();
    },
  };
  return session;
}
