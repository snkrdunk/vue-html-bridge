// Adapter session lifecycle (analyzer.md §9.2, §10.2, §11; validator-api
// §3.1): a failed createSession disables only that adapter — everything
// else still runs. Each entry owns a validation cache (discarded together
// with the session) and tracks in-flight validate() calls so a session is
// only disposed once analyses that reference it have completed or aborted
// (§11 step 3).
import {
  isAdapterSessionFailure,
  type AdapterFailure,
  type HtmlValidatorAdapter,
  type ValidateHtmlResult,
  type ValidatorSession,
} from "@vue-html-bridge/validator-api";
import {
  createValidationCache,
  hashSettings,
} from "./cache/validation-cache.js";
import type { BoundedLruCache } from "./cache/lru.js";
import type { AnalyzerLogger, ConfiguredAdapter } from "./types.js";

const VALIDATION_CACHE_OPTIONS = {
  maxEntries: 2000,
  maxApproximateBytes: 8 * 1024 * 1024,
};

export interface AdapterSessionEntry {
  adapterId: string;
  adapter: HtmlValidatorAdapter;
  settings: unknown;
  settingsHash: string;
  session?: ValidatorSession;
  sessionFailure?: AdapterFailure;
  validationCache: BoundedLruCache<ValidateHtmlResult>;
  activeCalls: number;
  drainWaiters: (() => void)[];
}

export async function createSessions(
  configured: readonly ConfiguredAdapter[],
  workspaceRoot: string,
  logger: AnalyzerLogger,
): Promise<readonly AdapterSessionEntry[]> {
  const enabled = configured.filter((entry) => entry.enabled);
  return Promise.all(
    enabled.map((entry) => createSessionEntry(entry, workspaceRoot, logger)),
  );
}

export async function createSessionEntry(
  entry: ConfiguredAdapter,
  workspaceRoot: string,
  logger: AnalyzerLogger,
): Promise<AdapterSessionEntry> {
  const base = {
    adapterId: entry.adapter.id,
    adapter: entry.adapter,
    settings: entry.settings,
    settingsHash: hashSettings(entry.settings),
    validationCache: createValidationCache(VALIDATION_CACHE_OPTIONS),
    activeCalls: 0,
    drainWaiters: [],
  };

  // ADR-0007: a shallow JSON-safety check on ConfiguredAdapter.settings,
  // run before createSession. A failure is a session-level
  // configuration-error, isolated to this one adapter exactly like any
  // other session-creation failure.
  if (entry.settings !== undefined && !isJsonSafe(entry.settings)) {
    return {
      ...base,
      sessionFailure: {
        code: "configuration-error",
        message: `The "${entry.adapter.id}" adapter's settings are not JSON-safe (they contain a function, a circular reference, or another unsupported value).`,
        recoverable: true,
      },
    };
  }

  try {
    const session = await entry.adapter.createSession({
      workspaceRoot,
      settings: entry.settings,
      logger,
    });
    return { ...base, session };
  } catch (error) {
    if (isAdapterSessionFailure(error)) {
      return { ...base, sessionFailure: error.failure };
    }
    logger.error(
      "Adapter createSession rejected without an AdapterSessionFailure shape.",
      { adapterId: entry.adapter.id },
    );
    return {
      ...base,
      sessionFailure: {
        code: "execution-error",
        message: `The "${entry.adapter.id}" adapter failed to start.`,
        recoverable: false,
      },
    };
  }
}

/** Wraps a live session's validate() call so dispose() can wait it out. */
export async function callSession(
  entry: AdapterSessionEntry,
  request: Parameters<ValidatorSession["validate"]>[0],
  signal: AbortSignal,
): Promise<ValidateHtmlResult> {
  if (!entry.session) {
    throw new Error(`Adapter "${entry.adapterId}" has no live session.`);
  }
  entry.activeCalls += 1;
  try {
    return await entry.session.validate(request, signal);
  } finally {
    entry.activeCalls -= 1;
    if (entry.activeCalls === 0) {
      const waiters = entry.drainWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}

async function waitForDrain(entry: AdapterSessionEntry): Promise<void> {
  if (entry.activeCalls === 0) return;
  await new Promise<void>((resolve) => entry.drainWaiters.push(resolve));
}

/**
 * §11 step 3: dispose of each session only once analyses that reference it
 * have completed or been aborted.
 */
export async function disposeSessions(
  entries: readonly AdapterSessionEntry[],
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      await waitForDrain(entry);
      await entry.session?.dispose();
    }),
  );
}

function isJsonSafe(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (type !== "object") return false; // function, symbol, bigint, undefined
  if (seen.has(value)) return false; // circular reference
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonSafe(item, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((item) =>
    isJsonSafe(item, seen),
  );
}
