// Orchestration (analyzer.md §4): run core once, run adapters with bounded
// concurrency, reverse-map, and merge into one result. Phase 1 scope: no
// provenance rewrite/suppression (§7) and no two-stage aggregation (§8) — one
// occurrence maps to one source diagnostic; caching (§10) is not implemented;
// reconfigure (§11) is a full session rebuild rather than a diffed swap.
import { performance } from "node:perf_hooks";
import {
  generateVariants,
  type HtmlVariant,
  type MappingEntry,
  type SourceRange,
} from "vue-html-bridge";
import {
  nullLogger,
  type ValidateHtmlResult,
} from "@vue-html-bridge/validator-api";
import {
  adapterFailureToSource,
  coreDiagnosticsToSource,
} from "./diagnostics.js";
import { remapDiagnostic } from "./remap.js";
import {
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

  async function analyze(request: AnalyzeRequest): Promise<AnalysisResult> {
    const started = performance.now();
    request.signal.throwIfAborted();

    const generated = await generateVariants({
      filename: request.filename,
      source: request.source,
      options: generateOptions,
      typeContext,
      signal: request.signal,
    });
    request.signal.throwIfAborted();

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

    const tasks: BoundedTask<(typeof workItems)[number], ValidateHtmlResult>[] =
      workItems.map((item) => {
        const entry = entryById.get(item.adapterId)!;
        return {
          item,
          adapterId: item.adapterId,
          supportsCancellation: entry.adapter.capabilities.supportsCancellation,
          run: (signal) =>
            entry.session.validate(
              {
                html: item.html,
                documentKind: "fragment",
                sourceFilename: request.filename,
                virtualFilename: item.virtualFilename,
              },
              signal,
            ),
        };
      });

    const outcomes = await runBounded(
      tasks,
      maxConcurrency,
      perAdapterLimits,
      request.signal,
    );
    request.signal.throwIfAborted();

    const adapterDiagnostics: SourceDiagnostic[] = [];
    for (const outcome of outcomes) {
      const { item } = outcome;
      if (outcome.error !== undefined) {
        logger.error("Adapter validate() rejected.", {
          adapterId: item.adapterId,
        });
        adapterDiagnostics.push(
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
        adapterDiagnostics.push(
          adapterFailureToSource(item.adapterId, failure, templateFallback),
        );
      }
      if (result.diagnostics.length === 0) continue;
      const representative = variantById.get(item.representativeVariantId);
      const map: readonly MappingEntry[] = representative?.map ?? [];
      for (const diagnostic of result.diagnostics) {
        adapterDiagnostics.push(
          remapDiagnostic(diagnostic, {
            adapterId: item.adapterId,
            map,
            templateFallback,
            html: item.html,
            virtualFilename: item.virtualFilename,
            memberVariantIds: item.memberVariantIds,
            representativeDecisions: representative?.decisions ?? [],
          }),
        );
      }
    }

    const diagnostics = sortDiagnostics([
      ...coreDiagnostics,
      ...sessionFailureDiagnostics,
      ...adapterDiagnostics,
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
    }
    if (reconfigureOptions.maxConcurrency !== undefined) {
      maxConcurrency = reconfigureOptions.maxConcurrency;
    }
    const needsSessionRebuild =
      reconfigureOptions.adapters !== undefined ||
      (reconfigureOptions.invalidateAdapters?.length ?? 0) > 0;
    if (!needsSessionRebuild) return;

    if (reconfigureOptions.adapters !== undefined) {
      configuredAdapters = reconfigureOptions.adapters;
    }
    const previousEntries = entries;
    entries = await createSessions(configuredAdapters, workspaceRoot, logger);
    await disposeSessions(previousEntries);
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
    await disposeSessions(entries);
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
