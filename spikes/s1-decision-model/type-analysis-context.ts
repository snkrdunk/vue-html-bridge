// Spike for ADR-0002 (core.md §2): prototypes the `TypeAnalysisContext`
// abstraction both ways — core-owned vs. caller-injected — over a minimal
// filesystem seam, so we can evaluate unsaved-buffer support, invalidation,
// and cross-file type-import resolution with real code before deciding.

import { existsSync, readFileSync } from "node:fs";
import { invalidateTypeCache } from "@vue/compiler-sfc";
import { invalidateScope } from "./prop-domain.js";

export interface TypeAnalysisFs {
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
}

/**
 * The full surface core needs from a type-analysis project: a file-read seam
 * (so unsaved editor buffers can shadow disk content) plus a monotonic epoch
 * that bumps whenever a file relevant to a previous resolution changes. This
 * is deliberately NOT a `ts.LanguageService`/`ts.server.ProjectService` — see
 * FINDINGS.md for why a much smaller surface turned out to be sufficient.
 */
export interface TypeAnalysisContext {
  readonly fs: TypeAnalysisFs;
  readonly epoch: number;
  /** Bumps the epoch and evicts any resolver-owned cache entries for these files. */
  invalidate(filenames: readonly string[]): void;
}

class RealFs implements TypeAnalysisFs {
  fileExists(filename: string): boolean {
    return existsSync(filename);
  }
  readFile(filename: string): string | undefined {
    try {
      return readFileSync(filename, "utf-8");
    } catch {
      return undefined;
    }
  }
}

/**
 * Model (a): core owns the context internally. Because core has no
 * independent signal that a dependency file changed (it isn't a file
 * watcher — monorepo.md §3 keeps that responsibility at the host boundary),
 * a core-owned context can only ever be "always fresh from disk" (safe, but
 * re-reads/re-parses every dependency on every call) or "cached forever
 * until the process restarts" (fast, but silently stale the moment an
 * imported type file changes on disk without a new `generateVariants` call
 * being told about it). Both are real options; neither can react to an
 * editor's unsaved buffer for a file OTHER than the SFC itself, because core
 * has no channel to receive that content unless the caller hands it in
 * per-call — which is exactly what model (b) does.
 */
export function createCoreOwnedContext(
  options: { alwaysFresh?: boolean } = {},
): TypeAnalysisContext {
  const fs = new RealFs();
  let epoch = 0;
  return {
    fs,
    get epoch() {
      return epoch;
    },
    invalidate(_filenames) {
      // A core-owned context has no external change feed, so the only
      // meaningful "invalidate" is a full bump — it cannot selectively
      // evict per-file, because it never learned about the change from
      // anyone but itself calling this method reactively (unlikely in
      // practice; nothing inside core observes the filesystem).
      if (!options.alwaysFresh) epoch += 1;
    },
  };
}

/**
 * Model (b): the caller (language server / analyzer / CLI) owns file
 * content and change notifications, and constructs the context explicitly,
 * injecting an `fs` that can serve unsaved buffers ahead of disk content and
 * calling `invalidate()` when it observes a relevant change (didChange for
 * an open buffer, a file-watcher event for a file that isn't open).
 */
export function createInjectedContext(
  overrides: ReadonlyMap<string, string>,
  baseFs: TypeAnalysisFs = new RealFs(),
): TypeAnalysisContext {
  let epoch = 0;
  const fs: TypeAnalysisFs = {
    fileExists(filename) {
      return overrides.has(filename) || baseFs.fileExists(filename);
    },
    readFile(filename) {
      return overrides.has(filename)
        ? overrides.get(filename)
        : baseFs.readFile(filename);
    },
  };
  return {
    fs,
    get epoch() {
      return epoch;
    },
    invalidate(filenames) {
      epoch += 1;
      // Both caches need an explicit poke: `@vue/compiler-sfc`'s own
      // `fileToScopeCache` (used by `resolveTypeElements` for the outer
      // object shape) is filename-keyed with NO content comparison, so it
      // serves stale data forever without this call. This module's own
      // scope cache (prop-domain.ts) happens to self-invalidate on content
      // change, but calling it here too keeps both caches on one signal
      // instead of relying on that as an accident of implementation.
      for (const filename of filenames) {
        invalidateTypeCache(filename);
        invalidateScope(filename);
      }
    },
  };
}
