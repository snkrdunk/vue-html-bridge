// Config resolution (adapter-markuplint.md §4). Markuplint's own config search
// and its parser/override matching both key off the same "filename" concept,
// which conflicts with validating already-generated HTML under a synthetic
// name. We resolve the nearest config from `sourceFilename`'s directory
// ourselves, then pass it explicitly to MLEngine with `noSearchConfig: true`
// so it never re-searches starting from the (unrelated) virtual directory.
import { dirname, resolve as resolvePath } from "node:path";
import { cosmiconfig, defaultLoaders, type PublicExplorer } from "cosmiconfig";
import { jsonc } from "jsonc";
import { MLEngine } from "markuplint";
import type { AdapterFailure } from "@vue-html-bridge/validator-api";
import type { MarkuplintAdapterSettings } from "./settings.js";

export interface ResolvedConfig {
  /** Absolute path of the config to pass as MLEngine's `configFile`, if any. */
  configFilePath: string | undefined;
  /**
   * Set when resolution itself failed (§7: config/plugin errors), e.g. a
   * plugin whose module throws while loading. `MLEngine.resolveConfig()`,
   * called directly here (not via `exec()`, which absorbs this into a
   * `config-error` violation itself — see engine.ts), has no such guard, so
   * we provide the same classification ourselves.
   */
  failure?: AdapterFailure;
}

/**
 * Caches the resolved config path per source directory (§4.3): explicit
 * `settings.configFile` resolves to the same path regardless of directory,
 * but caching this way means both cases share one lookup path and one cache.
 */
export class ConfigResolver {
  private readonly cache = new Map<string, Promise<ResolvedConfig>>();
  // One explorer per resolver instance (i.e. per adapter session, §4.3): its
  // internal cache is scoped to this instance's lifetime, so a session
  // recreated after a config-file change (reconfigure({invalidateAdapters}))
  // gets a genuinely fresh search — see searchUpward's doc comment for why
  // MLEngine's own search path can't provide that guarantee.
  private readonly searchExplorer = createSearchExplorer();

  constructor(
    private readonly workspaceRoot: string,
    private readonly settings: MarkuplintAdapterSettings,
  ) {}

  async resolve(sourceFilename: string): Promise<ResolvedConfig> {
    if (this.settings.configFile) {
      // Explicit config does not depend on sourceFilename's directory at all.
      const cacheKey = "\0explicit";
      let cached = this.cache.get(cacheKey);
      if (!cached) {
        const configFilePath = resolvePath(
          this.workspaceRoot,
          this.settings.configFile,
        );
        // Best-effort freshness for reconfigure (see bustStaleConfigCache):
        // runs once per session, piggybacking on this same Promise cache, so
        // a session created after a config edit isn't guaranteed to keep
        // serving pre-edit content for the rest of the process's lifetime.
        cached = bustStaleConfigCache(configFilePath)
          .then((): ResolvedConfig => ({ configFilePath }))
          .catch((error: unknown): ResolvedConfig => ({
            configFilePath: undefined,
            failure: describeConfigResolutionFailure(error),
          }));
        this.cache.set(cacheKey, cached);
      }
      return cached;
    }
    if (this.settings.searchConfig === false) {
      return { configFilePath: undefined };
    }
    const sourceDir = dirname(sourceFilename);
    let cached = this.cache.get(sourceDir);
    if (!cached) {
      cached = this.searchUpward(sourceDir);
      this.cache.set(sourceDir, cached);
    }
    return cached;
  }

  /**
   * Finds the nearest config from `sourceDir` upward — the same search
   * `configFilePatterns` documents as candidates.
   *
   * This deliberately does NOT go through `MLEngine.resolveConfig()` (as an
   * earlier version did, via a throwaway engine): `@markuplint/file-resolver`
   * v4.18.3's *discovery* phase (`ConfigProvider.search()`) always calls its
   * search helper with `cacheClear` hardcoded to `false`, and that helper
   * holds a single cosmiconfig explorer in a module-level singleton shared
   * by every `MLEngine` instance for the life of the process — verified
   * empirically: even two direct, independent `resolveConfig(false)` calls
   * in the same process never see a config file created between them.
   * `resolveConfig(false)`'s own cache-busting (see `resolveConfigFresh`)
   * only reaches that singleton as a side effect of *loading* an
   * already-known path; it never reaches the discovery-search cache, so it
   * can never satisfy language-server.md §9.3's "a nearer config created
   * after the session was initialized" guarantee for auto-search. Using our
   * own per-instance explorer sidesteps the singleton entirely for
   * discovery: a session recreated via `invalidateAdapters` gets a
   * brand-new `ConfigResolver`, hence a brand-new explorer with an empty
   * cache.
   *
   * Discovery alone isn't sufficient, though: once a path is found, the
   * *real* validation run later still loads that path's content through
   * `MLEngine`'s own engine (`engine.ts`, `configFile: <this path>`), which
   * goes through the very same process-wide content cache described above.
   * `bustStaleConfigCache` (shared with the explicit-`configFile` branch)
   * clears that cache too, so a config whose *content* changed between
   * sessions (path unchanged) is also read fresh.
   */
  private async searchUpward(sourceDir: string): Promise<ResolvedConfig> {
    try {
      const result = await this.searchExplorer.search(sourceDir);
      const configFilePath = result?.filepath;
      if (configFilePath !== undefined) {
        await bustStaleConfigCache(configFilePath);
      }
      return { configFilePath };
    } catch (error) {
      // §7: a plugin/parser import failure (or any other resolution error)
      // discovered here — before there's even a real MLEngine validation run —
      // is a configuration-error, same as one discovered during exec().
      return {
        configFilePath: undefined,
        failure: describeConfigResolutionFailure(error),
      };
    }
  }
}

/**
 * Matches `@markuplint/file-resolver`'s own (unexported) explorer
 * configuration exactly, so search results/precedence stay identical to
 * what `MLEngine`'s real validation later loads via `configFile` — same
 * JSONC-tolerant loader for extension-less `.markuplintrc`, same
 * `searchStrategy`. See `ConfigResolver.searchUpward`'s doc comment for why
 * this package needs its own explorer instance rather than reusing theirs.
 */
function createSearchExplorer(): PublicExplorer {
  return cosmiconfig("markuplint", {
    loaders: {
      noExt: (filePath: string, content: string) => {
        try {
          return jsonc.parse(content) as unknown;
        } catch (error) {
          if (error instanceof Error && error.name === "JSONError") {
            return defaultLoaders.noExt(filePath, content);
          }
          throw error;
        }
      },
    },
    searchStrategy: "project",
  });
}

function describeConfigResolutionFailure(error: unknown): AdapterFailure {
  return {
    code: "configuration-error",
    message:
      error instanceof Error
        ? `Markuplint failed to resolve configuration: ${error.message}`
        : "Markuplint failed to resolve configuration.",
    recoverable: true,
  };
}

/**
 * Forces a fresh read for whatever config `resolveConfigFresh` touches, as a
 * side effect, for a directory near an *explicit* `settings.configFile` —
 * `ConfigResolver`'s explicit branch never otherwise creates an engine or
 * calls `resolveConfig()` at all, so nothing would ever invalidate a stale
 * read of that exact file across a reconfigure (session dispose + recreate,
 * §4.3) otherwise. This is a best-effort mitigation, not a guarantee: it only
 * helps when *some* config file (the explicit one or otherwise) is
 * discoverable via Markuplint's own upward search from the explicit config's
 * directory (see resolveConfigFresh's own doc comment for why — clearing the
 * cache happens as a side effect of a *successful* config read, and nothing
 * upward means no such read ever happens). A workspace whose only Markuplint
 * config is a single, non-standardly-named `configFile` with nothing else
 * discoverable anywhere upward keeps this residual limitation.
 */
async function bustStaleConfigCache(nearFile: string): Promise<void> {
  const engine = await MLEngine.fromCode("", { name: nearFile });
  try {
    await resolveConfigFresh(engine);
  } finally {
    await engine.close();
  }
}

/**
 * `MLEngine`'s public API has no way to force a fresh disk read of config
 * content: `exec()` always resolves config with an internal, non-overridable
 * `cache: true`, and the underlying `@markuplint/file-resolver` package
 * caches loaded config *content* in a process-wide singleton keyed by file
 * path, entirely independent of any one `MLEngine`/session instance, so a
 * config file edited between one session and the next (§4.3's "dispose the
 * whole session and create a new one" reconfigure) can otherwise keep
 * serving pre-edit content for the rest of the process's lifetime.
 *
 * `resolveConfig(false)` is the only public lever that reaches this cache,
 * but it does so as an *unconditional* side effect of `ConfigProvider`
 * clearing its own per-instance stores before resolving — which, empirically
 * against the pinned Markuplint version, also incorrectly wipes out the
 * *synthetic*, UUID-keyed config entries (from `defaultConfig`/`config`
 * options, or Markuplint's own "no config found anywhere" fallback) that the
 * very same resolution just created, before they're looked up — a real
 * `@markuplint/file-resolver` defect, not intentional behavior. That crashes
 * with a `TypeError` in exactly those cases. A plain, option-free auto-search
 * call (as used here) never creates one of those
 * synthetic entries as long as it finds a real config file, so `false`
 * succeeds — and successfully clears the process-wide *content* cache for
 * *all* paths (though never the discovery-search cache — see
 * `ConfigResolver.searchUpward`'s doc comment),
 * not just the one this call happened to touch, which is what benefits a
 * *different* explicit `configFile` path validated moments later. Falling
 * back to `true` (the original, safe, cache-serving behavior) on any
 * failure keeps this from ever being worse than the pre-existing behavior.
 */
async function resolveConfigFresh(
  engine: MLEngine,
): Promise<Awaited<ReturnType<MLEngine["resolveConfig"]>>> {
  try {
    return await engine.resolveConfig(false);
  } catch {
    return await engine.resolveConfig(true);
  }
}
