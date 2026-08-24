/**
 * `loadConfiguredAdapters` orchestration (adapter-loader.md §3-4). Turns
 * resolved `validators[]` entries into ready-to-use adapter instances,
 * applying the built-in / external gates in order and isolating every
 * failure to its own entry (§4 item 3).
 */
import {
  checkHtmlValidatorAdapter,
  nullLogger,
  VALIDATOR_API_VERSION,
  type AdapterLogger,
  type HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";
import { dedupeFailures, makeFailure } from "./failures.js";
import {
  isExternalAdaptersModeEnabled,
  isPlainPackageSpecifier,
  isWorkspaceTrusted,
} from "./gates.js";
import {
  AdapterModuleResolutionError,
  nodeModuleResolver,
} from "./resolver.js";
import type {
  AdapterLoadFailure,
  LoadAdaptersRequest,
  LoadAdaptersResult,
  LoadedAdapter,
} from "./types.js";

/** One entry's outcome once it has (potentially) been loaded, before the
 * cross-entry duplicate-runtime-id pass (§4 item 4). */
interface PendingEntry {
  loaded: LoadedAdapter;
  /**
   * The adapter's real runtime `.id`, or `undefined` for a disabled
   * external placeholder — its real id is unknown because it was never
   * imported (§4's final paragraph), so it is excluded from the
   * duplicate-id check below rather than risk a false collision against a
   * fabricated id.
   */
  runtimeId: string | undefined;
}

export async function loadConfiguredAdapters(
  request: LoadAdaptersRequest,
): Promise<LoadAdaptersResult> {
  const resolveModule = request.moduleResolver ?? nodeModuleResolver;
  const logger: AdapterLogger = request.logger ?? nullLogger;
  const failures: AdapterLoadFailure[] = [];
  const pending: PendingEntry[] = [];

  for (const entry of request.validators) {
    const specifier = entry.adapter;
    const builtin = request.builtins.get(specifier);

    if (builtin) {
      const builtinEntry = loadBuiltinEntry(
        specifier,
        builtin,
        entry.settings,
        entry.enabled,
        failures,
        logger,
      );
      if (builtinEntry) pending.push(builtinEntry);
      continue;
    }

    if (!entry.enabled) {
      // §4 final paragraph: a disabled external entry is never imported —
      // no gate runs and no failure is ever recorded for it.
      pending.push({
        loaded: {
          adapter: createDisabledPlaceholderAdapter(specifier),
          settings: entry.settings,
          enabled: false,
          entryKey: specifier,
        },
        runtimeId: undefined,
      });
      continue;
    }

    const result = await loadExternalEntry(
      specifier,
      entry.settings,
      request,
      resolveModule,
      logger,
    );
    if (result.ok) {
      pending.push(result.entry);
    } else {
      failures.push(result.failure);
    }
  }

  const adapters = resolveDuplicateRuntimeIds(pending, failures);
  return { adapters, failures: dedupeFailures(failures) };
}

function loadBuiltinEntry(
  specifier: string,
  builtin: HtmlValidatorAdapter<unknown>,
  settings: unknown,
  enabled: boolean,
  failures: AdapterLoadFailure[],
  logger: AdapterLogger,
): PendingEntry | undefined {
  // §4 item 1: built-ins bypass every external gate, but not the runtime
  // shape / apiVersion assertion — checked unconditionally, even for a
  // disabled entry, since the instance is already in memory and checking
  // it runs no workspace code.
  const check = checkHtmlValidatorAdapter(builtin);
  if (!check.ok) {
    failures.push(makeFailure(specifier, check.kind, check.message));
    logger.warn("Built-in adapter failed its runtime check.", {
      specifier,
      kind: check.kind,
    });
    return undefined;
  }
  return {
    loaded: {
      adapter: check.adapter,
      settings,
      enabled,
      entryKey: specifier,
    },
    runtimeId: check.adapter.id,
  };
}

type ExternalLoadResult =
  | { ok: true; entry: PendingEntry }
  | { ok: false; failure: AdapterLoadFailure };

async function loadExternalEntry(
  specifier: string,
  settings: unknown,
  request: LoadAdaptersRequest,
  resolveModule: NonNullable<LoadAdaptersRequest["moduleResolver"]>,
  logger: AdapterLogger,
): Promise<ExternalLoadResult> {
  // §4 item 2, in order. Bullet 1 ("explicit in settings") is trivially
  // true — being here means the entry came from `request.validators`.
  if (!isExternalAdaptersModeEnabled(request.trust)) {
    return {
      ok: false,
      failure: makeFailure(
        specifier,
        "external-adapters-disabled",
        `External adapters are disabled for this workspace (externalAdapters !== "trusted-workspace-only"); "${specifier}" was not loaded.`,
      ),
    };
  }
  if (!isWorkspaceTrusted(request.trust)) {
    return {
      ok: false,
      failure: makeFailure(
        specifier,
        "workspace-not-trusted",
        `The workspace is not trusted; external adapter "${specifier}" was not loaded.`,
      ),
    };
  }
  if (!isPlainPackageSpecifier(specifier)) {
    return {
      ok: false,
      failure: makeFailure(
        specifier,
        "invalid-specifier",
        `"${specifier}" is not a plain npm package specifier — relative/absolute paths, URLs, and data URIs are rejected without any resolution attempt.`,
      ),
    };
  }

  let moduleValue: unknown;
  try {
    moduleValue = await resolveModule(specifier, request.workspaceRoot);
  } catch (error) {
    logger.warn("External adapter failed to load.", { specifier });
    if (error instanceof AdapterModuleResolutionError) {
      return {
        ok: false,
        failure: makeFailure(specifier, "resolution-failed", error.message),
      };
    }
    return {
      ok: false,
      failure: makeFailure(
        specifier,
        "import-threw",
        `Importing "${specifier}" threw: ${errorMessage(error)}`,
      ),
    };
  }

  const check = checkHtmlValidatorAdapter(extractAdapterExport(moduleValue));
  if (!check.ok) {
    return {
      ok: false,
      failure: makeFailure(specifier, check.kind, check.message),
    };
  }

  return {
    ok: true,
    entry: {
      loaded: {
        adapter: check.adapter,
        settings,
        enabled: true,
        entryKey: specifier,
      },
      runtimeId: check.adapter.id,
    },
  };
}

/**
 * §4 item 4: runtime `adapter.id` values must be unique across the result;
 * entry order decides which one is kept, and a collision fails the later
 * entry (excluded from `adapters`, recorded in `failures`).
 */
function resolveDuplicateRuntimeIds(
  pending: readonly PendingEntry[],
  failures: AdapterLoadFailure[],
): readonly LoadedAdapter[] {
  const firstEntryKeyById = new Map<string, string>();
  const adapters: LoadedAdapter[] = [];
  for (const entry of pending) {
    if (entry.runtimeId === undefined) {
      adapters.push(entry.loaded);
      continue;
    }
    const firstEntryKey = firstEntryKeyById.get(entry.runtimeId);
    if (firstEntryKey !== undefined) {
      failures.push(
        makeFailure(
          entry.loaded.entryKey,
          "duplicate-runtime-id",
          `Adapter id "${entry.runtimeId}" from "${entry.loaded.entryKey}" duplicates the one already loaded from "${firstEntryKey}"; "${entry.loaded.entryKey}" was not loaded.`,
        ),
      );
      continue;
    }
    firstEntryKeyById.set(entry.runtimeId, entry.loaded.entryKey);
    adapters.push(entry.loaded);
  }
  return adapters;
}

function extractAdapterExport(moduleValue: unknown): unknown {
  if (
    typeof moduleValue === "object" &&
    moduleValue !== null &&
    "default" in moduleValue &&
    (moduleValue as { default?: unknown }).default !== undefined
  ) {
    return (moduleValue as { default: unknown }).default;
  }
  return moduleValue;
}

function createDisabledPlaceholderAdapter(
  entryKey: string,
): HtmlValidatorAdapter<unknown> {
  return {
    apiVersion: VALIDATOR_API_VERSION,
    id: entryKey,
    displayName: entryKey,
    capabilities: {
      execution: "in-process",
      supportsCancellation: false,
      supportsConfigFiles: false,
      fragmentHandling: "native",
      maxConcurrentValidations: 1,
    },
    createSession() {
      // Never called: the analyzer only creates sessions for enabled
      // adapters (analyzer/src/sessions.ts filters on `entry.enabled`
      // first), and this instance was never imported — it exists only to
      // satisfy `LoadedAdapter.adapter`'s non-optional type for a disabled
      // external entry (§4's final paragraph) without running any
      // workspace code.
      throw new Error(
        `The adapter for the disabled entry "${entryKey}" must never be used.`,
      );
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
