// Trust: how the built-in Markuplint adapter's own settings are shaped by
// workspace trust (language-server.md §4.2, §10.1). Loading itself —
// including the built-in/external split — lives in adapters/loading.ts,
// a thin wrapper over @vue-html-bridge/adapter-loader.
import type { ResolvedValidatorSetting } from "@vue-html-bridge/settings";

export const BUILTIN_MARKUPLINT_ID = "markuplint";

/**
 * §4.2: in an untrusted workspace, the built-in Markuplint adapter runs
 * with its bundled, safe default config — no `configFile`, forced
 * `searchConfig: false`, so it never loads workspace JS config or plugins.
 * A trusted workspace uses the entry's own configured settings unchanged.
 */
export function builtinMarkuplintSettings(
  entry: ResolvedValidatorSetting | undefined,
  workspaceTrusted: boolean,
): unknown {
  if (!workspaceTrusted) return { searchConfig: false };
  return entry?.settings ?? {};
}
