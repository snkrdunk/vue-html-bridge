// Config-file watching (language-server.md §9.3): computing what the client
// should watch, and mapping an incoming file-change event back to the
// session/adapter(s) whose config it affects. `configFilePatterns` are
// candidate globs for a not-yet-discovered/newly-created config; concrete
// `getConfigWatchTargets()` entries are already-resolved, adapter-tagged
// files. The language server never inspects `validators[].settings` for an
// adapter-specific field — everything here comes from the SPI (validator-api
// §3, analyzer.md §2).
import { minimatch } from "minimatch";
import type { WorkspaceSession } from "../workspace/session.js";

export interface WatchRegistrationPlan {
  /** Deduplicated, sorted candidate globs from every enabled adapter's capabilities. */
  patternGlobs: readonly string[];
  /** Deduplicated, sorted concrete absolute paths from every session's current snapshot. */
  concreteAbsolutePaths: readonly string[];
}

/**
 * Reads each session's `lastWatchTargets` (not the analyzer directly) — the
 * caller is responsible for refreshing that snapshot first (§9.3: "after
 * analyzer creation/reconfiguration and after each analysis"), which is
 * also what `matchConfigChange` below relies on for concrete-target
 * attribution, so both read the same up-to-date snapshot.
 */
export function buildWatchRegistrationPlan(
  sessions: readonly WorkspaceSession[],
): WatchRegistrationPlan {
  const patterns = new Set<string>();
  const concrete = new Set<string>();
  for (const session of sessions) {
    for (const configured of session.configuredAdapters) {
      if (!configured.enabled) continue;
      for (const pattern of configured.adapter.capabilities
        .configFilePatterns ?? []) {
        patterns.add(pattern);
      }
    }
    for (const target of session.lastWatchTargets) {
      concrete.add(target.absolutePath);
    }
  }
  return {
    patternGlobs: [...patterns].sort(),
    concreteAbsolutePaths: [...concrete].sort(),
  };
}

export function watchPlansEqual(
  a: WatchRegistrationPlan,
  b: WatchRegistrationPlan,
): boolean {
  return (
    arraysEqual(a.patternGlobs, b.patternGlobs) &&
    arraysEqual(a.concreteAbsolutePaths, b.concreteAbsolutePaths)
  );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface ConfigChangeMatch {
  session: WorkspaceSession;
  /** Adapter ids (session-scoped) whose session must be recreated. */
  adapterIds: readonly string[];
}

/**
 * §9.3: a concrete-target match is attributed to the exact adapter it was
 * tagged with. A path that isn't (yet) a known concrete target but matches
 * one or more enabled adapters' `configFilePatterns` — a newly created
 * config — is attributed to every adapter whose pattern matches; this can
 * over-invalidate when two different adapters share an overlapping
 * pattern, which is safe (analyzer.md §10.2 already documents deliberate
 * over-invalidation elsewhere) and rare in practice.
 */
export function matchConfigChange(
  sessions: readonly WorkspaceSession[],
  changedAbsolutePath: string,
): ConfigChangeMatch | undefined {
  for (const session of sessions) {
    const concreteMatch = session.lastWatchTargets.find(
      (target) => target.absolutePath === changedAbsolutePath,
    );
    if (concreteMatch) {
      return { session, adapterIds: [concreteMatch.adapterId] };
    }
  }
  for (const session of sessions) {
    const matchedAdapterIds = session.configuredAdapters
      .filter(
        (configured) =>
          configured.enabled &&
          (configured.adapter.capabilities.configFilePatterns ?? []).some(
            (pattern) => matchesConfigCandidate(changedAbsolutePath, pattern),
          ),
      )
      .map((configured) => configured.adapter.id);
    if (matchedAdapterIds.length > 0) {
      return { session, adapterIds: matchedAdapterIds };
    }
  }
  return undefined;
}

function matchesConfigCandidate(
  absolutePath: string,
  pattern: string,
): boolean {
  // Verified empirically: minimatch's "**/..." patterns match an absolute
  // path directly (the leading "**" also absorbs the root segment) — no
  // separate rooted-vs-relative handling needed.
  return minimatch(absolutePath, pattern, { dot: true });
}
