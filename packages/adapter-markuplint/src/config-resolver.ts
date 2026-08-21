// Config resolution (adapter-markuplint.md §4). Markuplint's own config search
// and its parser/override matching both key off the same "filename" concept,
// which conflicts with validating already-generated HTML under a synthetic
// name. We resolve the nearest config from `sourceFilename`'s directory
// ourselves, then pass it explicitly to MLEngine with `noSearchConfig: true`
// so it never re-searches starting from the (unrelated) virtual directory.
import { isAbsolute, dirname, resolve as resolvePath } from "node:path";
import { MLEngine } from "markuplint";
import type { MarkuplintAdapterSettings } from "./settings.js";

export interface ResolvedConfig {
  /** Absolute path of the config to pass as MLEngine's `configFile`, if any. */
  configFilePath: string | undefined;
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
        cached = Promise.resolve({
          configFilePath: resolvePath(
            this.workspaceRoot,
            this.settings.configFile,
          ),
        });
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
    const configSet = await engine.resolveConfig(true);
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
  } finally {
    await engine.close();
  }
}
