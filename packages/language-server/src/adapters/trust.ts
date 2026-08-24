// Trust and adapter configuration (language-server.md §4.2, §10.1).
// External-adapter loading (§10.2, adapter-loader.md) is not wired in here
// yet; this module currently only builds the built-in Markuplint entry,
// gated by trust.
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import type { ConfiguredAdapter } from "@vue-html-bridge/analyzer";
import type { ResolvedValidatorSetting } from "@vue-html-bridge/settings";

const BUILTIN_MARKUPLINT_ID = "markuplint";

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

/**
 * Builds the adapter list a `WorkspaceAnalyzer` should be created/
 * reconfigured with. The built-in adapter only runs if `validators[]`
 * still names it (an explicit override that drops it — e.g. an empty
 * array — means "no built-in adapter", not "fall back to a hardcoded
 * default"; settings.md's own array-replacement semantics already make
 * this the resolved value's job, not this function's).
 *
 * External adapters (§10.2) are not loaded yet — that lands once
 * `@vue-html-bridge/adapter-loader` is wired in as a follow-up.
 */
export function buildConfiguredAdapters(
  validators: readonly ResolvedValidatorSetting[],
  workspaceTrusted: boolean,
): readonly ConfiguredAdapter[] {
  const markuplintEntry = validators.find(
    (entry) => entry.adapter === BUILTIN_MARKUPLINT_ID,
  );
  const markuplintEnabled = markuplintEntry?.enabled ?? false;
  if (!markuplintEnabled) return [];
  return [
    {
      adapter: markuplintAdapter,
      settings: builtinMarkuplintSettings(markuplintEntry, workspaceTrusted),
      enabled: true,
    },
  ];
}
