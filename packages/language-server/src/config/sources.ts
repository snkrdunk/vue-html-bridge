// Settings precedence (language-server.md §9.2): LSP workspace/configuration
// (or, when the client cannot fetch that, the initializationOptions
// fallback) layered over the discovered workspace file, resolved by the
// shared @vue-html-bridge/settings package. This module owns nothing about
// *what* the fields mean — only how the layers are assembled.
import {
  loadWorkspaceSettingsFile,
  resolveSettings,
  type ResolvedVueHtmlBridgeSettings,
  type SettingsFileSystem,
  type SettingsIssue,
  type VueHtmlBridgeSettingsInput,
} from "@vue-html-bridge/settings";

export interface ConfigurationClient {
  getConfiguration(section: string): Promise<unknown>;
}

export interface ResolveWorkspaceSettingsOptions {
  workspaceRoot: string;
  /** From VueHtmlBridgeInitializationOptions.settings (language-server.md §4.2). */
  initializationSettings: VueHtmlBridgeSettingsInput | undefined;
  /** Whether the client declared workspace.configuration support. */
  supportsWorkspaceConfiguration: boolean;
  configurationClient: ConfigurationClient;
  fileSystem: SettingsFileSystem;
}

export interface ResolvedWorkspaceSettings {
  settings: ResolvedVueHtmlBridgeSettings;
  issues: readonly SettingsIssue[];
  /** Absolute path of the discovered settings file, if one was found. */
  sourcePath?: string;
}

/**
 * §9.2 precedence: `workspace/configuration` (or the initialization-options
 * fallback when the client can't provide it) is the highest-precedence
 * layer; the discovered `.vue-html-bridge.json` / `package.json#vueHtmlBridge`
 * is next; defaults are implicit in `resolveSettings`.
 */
export async function resolveWorkspaceSettings(
  options: ResolveWorkspaceSettingsOptions,
): Promise<ResolvedWorkspaceSettings> {
  const discovered = await loadWorkspaceSettingsFile(
    options.workspaceRoot,
    options.fileSystem,
  );

  const topLayer = await resolveTopLayer(options);

  const { settings, issues } = resolveSettings([discovered.settings, topLayer]);
  return {
    settings,
    issues: [...discovered.issues, ...issues],
    sourcePath: discovered.sourcePath,
  };
}

async function resolveTopLayer(
  options: ResolveWorkspaceSettingsOptions,
): Promise<unknown> {
  if (!options.supportsWorkspaceConfiguration) {
    return options.initializationSettings ?? {};
  }
  try {
    const value =
      await options.configurationClient.getConfiguration("vueHtmlBridge");
    return value ?? {};
  } catch {
    // The client declared support but the request failed (or a test double
    // doesn't implement it) — fall back rather than losing settings entirely.
    return options.initializationSettings ?? {};
  }
}
