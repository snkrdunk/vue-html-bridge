/**
 * Failure construction, dedupe keys, and ordering (adapter-loader.md §3,
 * §4 items 4-5).
 */
import type { AdapterLoadFailure, AdapterLoadFailureKind } from "./types.js";

export function makeFailure(
  specifier: string,
  kind: AdapterLoadFailureKind,
  message: string,
): AdapterLoadFailure {
  return { specifier, kind, message, dedupeKey: `${specifier}:${kind}` };
}

/**
 * §4 item 5: failures are deduplicated by `dedupeKey`, keeping the first
 * occurrence. Entry order otherwise determines the result, so this is a
 * stable filter, not a sort — contrast
 * `analyzer/src/workspace-analyzer.ts`'s `getConfigWatchTargets`, which
 * dedupes *and* sorts because paths have no meaningful entry order; here
 * entry order already is the intended order.
 */
export function dedupeFailures(
  failures: readonly AdapterLoadFailure[],
): readonly AdapterLoadFailure[] {
  const byKey = new Map<string, AdapterLoadFailure>();
  for (const failure of failures) {
    if (!byKey.has(failure.dedupeKey)) byKey.set(failure.dedupeKey, failure);
  }
  return [...byKey.values()];
}
