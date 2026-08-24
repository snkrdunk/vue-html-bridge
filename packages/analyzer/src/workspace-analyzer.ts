// Orchestration (analyzer.md §4): run core once (cached, §10.1), run
// adapters with bounded concurrency (each cached per-session, §10.2),
// reverse-map (§6), normalize by provenance (§7), aggregate across variants
// (§8), and merge into one result (§9). reconfigure (§11) diffs adapters by
// settings hash rather than rebuilding every session.
import { performance } from "node:perf_hooks";
import {
  generateVariants,
  type HtmlVariant,
  type SourceRange,
} from "vue-html-bridge";
import { nullLogger } from "@vue-html-bridge/validator-api";
import { aggregateBySourceIdentity } from "./aggregate.js";
import {
  approximateGenerateResultBytes,
  createGenerationCache,
  generationCacheKey,
} from "./cache/generation-cache.js";
import {
  approximateValidationResultBytes,
  hashSettings,
  validationCacheKey,
} from "./cache/validation-cache.js";
import {
  adapterFailureToSource,
  coreDiagnosticsToSource,
} from "./diagnostics.js";
import { dedupeOccurrences, type DiagnosticOccurrence } from "./occurrence.js";
import { normalizeOccurrence } from "./provenance-normalizer.js";
import { remapOccurrence } from "./remap.js";
import {
  callSession,
  createSessionEntry,
  createSessions,
  disposeSessions,
  type AdapterSessionEntry,
} from "./sessions.js";
import type {
  AnalysisResult,
  AnalyzeRequest,
  AnalyzerConfigWatchTarget,
  AnalyzerLogger,
  ConfiguredAdapter,
  CreateWorkspaceAnalyzerOptions,
  ReconfigureOptions,
  SourceDiagnostic,
  WorkspaceAnalyzer,
} from "./types.js";
import { buildWorkItems } from "./work-deduplication.js";
import { runBounded, type BoundedTask } from "./validation-queue.js";

const DEFAULT_MAX_CONCURRENCY = 4;
const GENERATION_CACHE_OPTIONS = {
  maxEntries: 500,
  maxApproximateBytes: 32 * 1024 * 1024,
};

export async function createWorkspaceAnalyzer(
  options: CreateWorkspaceAnalyzerOptions,
): Promise<WorkspaceAnalyzer> {
  const workspaceRoot = options.workspaceRoot;
  const logger: AnalyzerLogger = options.logger ?? nullLogger;
  let generateOptions = options.generateOptions;
  const typeContext = options.typeContext;
  let maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  let configuredAdapters = options.adapters;
  let entries = await createSessions(configuredAdapters, workspaceRoot, logger);
  let disposed = false;
  const generationCache = createGenerationCache(GENERATION_CACHE_OPTIONS);
  let lastEpoch = typeContext?.epoch;
  const pendingDisposals: Promise<void>[] = [];

  async function analyze(request: AnalyzeRequest): Promise<AnalysisResult> {
    const started = performance.now();
    request.signal.throwIfAborted();

    const epoch = typeContext?.epoch ?? 0;
    if (epoch !== lastEpoch) {
      // §10.3: a TypeScript project epoch change invalidates the relevant
      // (generation) cache layer — stale entries keyed to the old epoch are
      // simply never looked up again, so a full clear just reclaims memory.
      generationCache.clear();
      lastEpoch = epoch;
    }
    const genKey = generationCacheKey({
      source: request.source,
      filename: request.filename,
      generateOptions,
      epoch,
    });
    let generated = generationCache.get(genKey);
    if (!generated) {
      generated = await generateVariants({
        filename: request.filename,
        source: request.source,
        options: generateOptions,
        typeContext,
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      generationCache.set(
        genKey,
        generated,
        approximateGenerateResultBytes(generated),
      );
    }

    const templateFallback: SourceRange = generated.templateRange ?? {
      filename: request.filename,
      start: 0,
      end: 0,
    };
    const coreDiagnostics = coreDiagnosticsToSource(generated.diagnostics);
    const sessionFailureDiagnostics = entries
      .filter(
        (
          entry,
        ): entry is AdapterSessionEntry & {
          sessionFailure: NonNullable<AdapterSessionEntry["sessionFailure"]>;
        } => entry.sessionFailure !== undefined,
      )
      .map((entry) =>
        adapterFailureToSource(
          entry.adapterId,
          entry.sessionFailure,
          templateFallback,
        ),
      );

    const liveEntries = entries.filter(
      (
        entry,
      ): entry is AdapterSessionEntry & {
        session: NonNullable<AdapterSessionEntry["session"]>;
      } => entry.session !== undefined,
    );
    const entryById = new Map(
      liveEntries.map((entry) => [entry.adapterId, entry]),
    );
    const variantById = new Map<string, HtmlVariant>(
      generated.variants.map((variant) => [variant.id, variant]),
    );

    const workItems = buildWorkItems(
      request.filename,
      generated.variants,
      liveEntries.map((entry) => entry.adapterId),
    );
    const perAdapterLimits = new Map(
      liveEntries.map((entry) => [
        entry.adapterId,
        entry.adapter.capabilities.maxConcurrentValidations,
      ]),
    );

    const tasks: BoundedTask<
      (typeof workItems)[number],
      Awaited<ReturnType<typeof callSession>>
    >[] = workItems.map((item) => {
      const entry = entryById.get(item.adapterId)!;
      return {
        item,
        adapterId: item.adapterId,
        run: async (signal) => {
          const cacheKey = validationCacheKey({
            settingsHash: entry.settingsHash,
            sourceFilename: request.filename,
            htmlHash: item.htmlHash,
          });
          const cached = entry.validationCache.get(cacheKey);
          if (cached) return cached;
          const result = await callSession(
            entry,
            {
              html: item.html,
              documentKind: "fragment",
              sourceFilename: request.filename,
              virtualFilename: item.virtualFilename,
            },
            signal,
          );
          entry.validationCache.set(
            cacheKey,
            result,
            approximateValidationResultBytes(result),
          );
          return result;
        },
      };
    });

    const outcomes = await runBounded(
      tasks,
      maxConcurrency,
      perAdapterLimits,
      request.signal,
    );
    request.signal.throwIfAborted();

    const adapterFailureDiagnostics: SourceDiagnostic[] = [];
    const occurrences: DiagnosticOccurrence[] = [];
    for (const outcome of outcomes) {
      const { item } = outcome;
      if (outcome.error !== undefined) {
        logger.error("Adapter validate() rejected.", {
          adapterId: item.adapterId,
        });
        adapterFailureDiagnostics.push(
          adapterFailureToSource(
            item.adapterId,
            {
              code: "execution-error",
              message: `The "${item.adapterId}" adapter failed to validate this content.`,
              recoverable: true,
            },
            templateFallback,
          ),
        );
        continue;
      }
      const result = outcome.result!;
      for (const failure of result.failures) {
        adapterFailureDiagnostics.push(
          adapterFailureToSource(item.adapterId, failure, templateFallback),
        );
      }
      if (result.diagnostics.length === 0) continue;
      const representative = variantById.get(item.representativeVariantId);
      const map = representative?.map ?? [];
      for (const memberVariantId of item.memberVariantIds) {
        const variant = variantById.get(memberVariantId);
        for (const diagnostic of result.diagnostics) {
          occurrences.push({
            adapterId: item.adapterId,
            variantId: memberVariantId,
            variantDecisions: variant?.decisions ?? [],
            virtualFilename: item.virtualFilename,
            map,
            diagnostic,
          });
        }
      }
    }

    const normalized = dedupeOccurrences(occurrences)
      .map((occurrence) => remapOccurrence(occurrence, templateFallback))
      .map(normalizeOccurrence)
      .filter((occurrence) => occurrence !== undefined);
    const validatorDiagnostics = aggregateBySourceIdentity(normalized);

    const diagnostics = sortDiagnostics([
      ...coreDiagnostics,
      ...sessionFailureDiagnostics,
      ...adapterFailureDiagnostics,
      ...validatorDiagnostics,
    ]);

    return {
      uri: request.uri,
      documentVersion: request.documentVersion,
      diagnostics,
      variantSummary: {
        candidateCount: generated.stats.candidateCount,
        emittedCount: generated.stats.emittedCount,
        uniqueHtmlCount: generated.stats.uniqueHtmlCount,
        warningThresholdExceeded: generated.stats.warningThresholdExceeded,
      },
      timing: { durationMs: performance.now() - started },
    };
  }

  async function reconfigure(
    reconfigureOptions: ReconfigureOptions,
  ): Promise<void> {
    if (reconfigureOptions.generateOptions !== undefined) {
      generateOptions = reconfigureOptions.generateOptions;
      generationCache.clear();
    }
    if (reconfigureOptions.maxConcurrency !== undefined) {
      maxConcurrency = reconfigureOptions.maxConcurrency;
    }

    const nextConfigured =
      reconfigureOptions.adapters !== undefined
        ? reconfigureOptions.adapters
        : configuredAdapters;
    const invalidate = new Set(reconfigureOptions.invalidateAdapters ?? []);
    const previousById = new Map(
      entries.map((entry) => [entry.adapterId, entry]),
    );
    const nextEnabled = nextConfigured.filter((entry) => entry.enabled);
    const seenAdapterIds = new Set<string>();

    const nextEntries: AdapterSessionEntry[] = [];
    const toDispose: AdapterSessionEntry[] = [];
    for (const configured of nextEnabled) {
      const adapterId = configured.adapter.id;
      seenAdapterIds.add(adapterId);
      const previous = previousById.get(adapterId);
      const settingsHash = hashSettings(configured.settings);
      const needsRecreate =
        !previous ||
        previous.settingsHash !== settingsHash ||
        invalidate.has(adapterId) ||
        // §9.2: a recoverable session failure is retried on the next reconfigure.
        (previous.sessionFailure?.recoverable ?? false);
      if (!needsRecreate) {
        nextEntries.push(previous);
        continue;
      }
      if (previous) toDispose.push(previous);
      nextEntries.push(
        await createSessionEntry(configured, workspaceRoot, logger),
      );
    }
    for (const previous of entries) {
      if (!seenAdapterIds.has(previous.adapterId)) toDispose.push(previous);
    }

    configuredAdapters = nextConfigured;
    entries = nextEntries;
    // §11 steps 2-3: the swap above is synchronous, so subsequent analyze()
    // calls only ever see the new sessions immediately. Draining and
    // disposing the replaced ones can take as long as their slowest
    // in-flight validate() call, so it happens in the background — awaiting
    // it here would make reconfigure() hang on a slow/stuck adapter call.
    // dispose() (full workspace shutdown) still waits for this to finish.
    if (toDispose.length > 0) {
      const disposal = disposeSessions(toDispose).catch((error: unknown) => {
        logger.error("Error disposing a replaced adapter session.", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      pendingDisposals.push(disposal);
    }
  }

  function getConfigWatchTargets(): readonly AnalyzerConfigWatchTarget[] {
    const byPath = new Map<string, AnalyzerConfigWatchTarget>();
    for (const entry of entries) {
      const targets = entry.session?.getConfigWatchTargets?.();
      if (!targets) continue;
      for (const target of targets) {
        if (!isValidWatchTarget(target)) {
          logger.error(
            "Adapter returned an invalid config watch target; ignored.",
            {
              adapterId: entry.adapterId,
            },
          );
          continue;
        }
        byPath.set(target.absolutePath, {
          ...target,
          adapterId: entry.adapterId,
        });
      }
    }
    return [...byPath.values()].sort((a, b) =>
      a.absolutePath.localeCompare(b.absolutePath),
    );
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await Promise.all([...pendingDisposals, disposeSessions(entries)]);
  }

  return { analyze, reconfigure, getConfigWatchTargets, dispose };
}

function isValidWatchTarget(
  target: unknown,
): target is { absolutePath: string; kind: "config" | "dependency" } {
  if (typeof target !== "object" || target === null) return false;
  const candidate = target as { absolutePath?: unknown; kind?: unknown };
  return (
    typeof candidate.absolutePath === "string" &&
    candidate.absolutePath.length > 0 &&
    (candidate.kind === "config" || candidate.kind === "dependency")
  );
}

function sortDiagnostics(
  diagnostics: readonly SourceDiagnostic[],
): readonly SourceDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.sourceRange.start - b.sourceRange.start ||
      a.sourceRange.end - b.sourceRange.end ||
      a.origin.localeCompare(b.origin) ||
      a.code.localeCompare(b.code) ||
      a.id.localeCompare(b.id),
  );
}

export type { ConfiguredAdapter };
