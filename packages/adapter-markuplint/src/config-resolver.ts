// Config resolution (adapter-markuplint.md §4). Markuplint's own config search
// and its parser/override matching both key off the same "filename" concept,
// which conflicts with validating already-generated HTML under a synthetic
// name. We resolve the nearest config from `sourceFilename`'s directory
// ourselves, then pass it explicitly to MLEngine with `noSearchConfig: true`
// so it never re-searches starting from the (unrelated) virtual directory.
import { isAbsolute, dirname, resolve as resolvePath } from "node:path";
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
      cached = searchUpward(sourceFilename);
      this.cache.set(sourceDir, cached);
    }
    return cached;
  }
}

/**
 * Uses Markuplint's own cosmiconfig-based search (via a throwaway engine that
 * is never linted) to find the nearest config from `sourceFilename`'s real
 * directory — the same search `configFilePatterns` documents as candidates.
 */
async function searchUpward(sourceFilename: string): Promise<ResolvedConfig> {
  const engine = await MLEngine.fromCode("", { name: sourceFilename });
  try {
    const configSet = await resolveConfigFresh(engine);
    // `configSet.files` orders a config's own *dependencies* (its `extends`
    // targets) before the config itself (Markuplint resolves extends first,
    // then appends the referencing file) — the last absolute path is the
    // discovered config Markuplint's search actually found, not one of its
    // dependencies. Preset names (`markuplint:...`) are filtered out by the
    // `isAbsolute` check, along with any injected default-recommended entry.
    const absoluteFiles = [...configSet.files].filter((file) =>
      isAbsolute(file),
    );
    return { configFilePath: absoluteFiles.at(-1) };
  } catch (error) {
    // §7: a plugin/parser import failure (or any other resolution error)
    // discovered here — before there's even a real MLEngine validation run —
    // is a configuration-error, same as one discovered during exec().
    return {
      configFilePath: undefined,
      failure: describeConfigResolutionFailure(error),
    };
  } finally {
    await engine.close();
  }
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
 * call (as used here and in `searchUpward`) never creates one of those
 * synthetic entries as long as it finds a real config file, so `false`
 * succeeds — and successfully clears the process-wide cache for *all* paths,
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
