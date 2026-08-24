// One workspace folder's session (language-server.md §9.1): owns its
// analyzer, TypeAnalysisContext, resolved settings, and the config
// watch-target snapshot used for diffing registrations (§9.3).
import type {
  AdapterLoadFailure,
  AdapterModuleResolver,
} from "@vue-html-bridge/adapter-loader";
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
import { loadAdaptersForSession } from "../adapters/loading.js";

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
  moduleResolver?: AdapterModuleResolver;
  logger?: AnalyzerLogger;
  /** §10.2: structured adapter-load failures for the caller to turn into per-workspace notices. */
  onAdapterLoadFailures?: (failures: readonly AdapterLoadFailure[]) => void;
}): Promise<WorkspaceSession> {
  const typeContext = createTypeAnalysisContext();
  const decomposed = decomposeSettings(options.settings);
  const initialLoad = await loadAdaptersForSession({
    validators: decomposed.validators,
    workspaceRoot: options.folderRoot,
    workspaceTrusted: options.workspaceTrusted,
    externalAdapters: decomposed.host.externalAdapters,
    moduleResolver: options.moduleResolver,
    logger: options.logger,
  });
  options.onAdapterLoadFailures?.(initialLoad.failures);
  const analyzer = await createWorkspaceAnalyzer({
    workspaceRoot: options.folderRoot,
    adapters: initialLoad.adapters,
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
    configuredAdapters: initialLoad.adapters,
    lastWatchTargets: [],
    async reconfigure(nextSettings, reconfigureOptions) {
      const nextDecomposed = decomposeSettings(nextSettings);
      const nextLoad = await loadAdaptersForSession({
        validators: nextDecomposed.validators,
        workspaceRoot: options.folderRoot,
        workspaceTrusted: session.workspaceTrusted,
        externalAdapters: nextDecomposed.host.externalAdapters,
        moduleResolver: options.moduleResolver,
        logger: options.logger,
      });
      options.onAdapterLoadFailures?.(nextLoad.failures);
      await analyzer.reconfigure({
        adapters: nextLoad.adapters,
        generateOptions: nextDecomposed.generateOptions,
        maxConcurrency: nextDecomposed.analyzer.maxConcurrency,
        invalidateAdapters: reconfigureOptions?.invalidateAdapters,
      });
      session.settings = nextSettings;
      session.configuredAdapters = nextLoad.adapters;
    },
    async dispose() {
      await analyzer.dispose();
    },
  };
  return session;
}
