// The execution model (cli.md §6, §8): enumeration, adapter loading,
// analyzer lifecycle, and the run-outcome model. This module takes an
// already-resolved settings object and a trust decision; it knows nothing
// about flags (cli.md §11).
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterModuleResolver } from "@vue-html-bridge/adapter-loader";
import {
  createWorkspaceAnalyzer,
  type SourceDiagnostic,
  type WorkspaceAnalyzer,
} from "@vue-html-bridge/analyzer";
import {
  decomposeSettings,
  type ResolvedVueHtmlBridgeSettings,
} from "@vue-html-bridge/settings";
import type {
  AdapterLogger,
  HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";
import { loadAdaptersForRun } from "./adapters.js";
import {
  isSessionFailureDiagnostic,
  projectDiagnostic,
  sortCliDiagnostics,
} from "./diagnostics.js";
import { enumerateFiles } from "./enumerate.js";
import {
  computeExitCode,
  EXIT_RUN_ERROR,
  severityMeetsThreshold,
  type FailOnThreshold,
} from "./exit-codes.js";
import { createLineIndex } from "./line-index.js";
import type {
  CliDiagnostic,
  OutputRenderer,
  RunLevelError,
  RunSummaryCounts,
} from "./types.js";

/** Bounded cleanup (cli.md §6 "Signals"): dispose never blocks exit indefinitely. */
const DISPOSE_TIMEOUT_MS = 3000;

export interface RunCliOptions {
  /** Absolute. */
  workspaceRoot: string;
  /** Absolute. */
  cwd: string;
  positionalArgs: readonly string[];
  settings: ResolvedVueHtmlBridgeSettings;
  workspaceTrusted: boolean;
  failOn: FailOnThreshold;
  signal: AbortSignal;
  renderer: OutputRenderer;
  /** stderr-only notices (untrusted-mode banner, pre-analysis "no analyzable input") — always stderr regardless of `--format` (cli.md §2, §7.2 stdout validity). */
  notice: (message: string) => void;
  /** Injectable for tests (adapter-loader.md §6 item 8's shared contract fixture, adapter-testkit's fake adapter). */
  moduleResolver?: AdapterModuleResolver;
  builtins?: ReadonlyMap<string, HtmlValidatorAdapter<unknown>>;
  logger?: AdapterLogger;
}

export type RunCliResult =
  { interrupted: true } | { interrupted: false; exitCode: number };

export async function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const decomposed = decomposeSettings(options.settings);

  const enumerated = await enumerateFiles({
    workspaceRoot: options.workspaceRoot,
    cwd: options.cwd,
    positionalArgs: options.positionalArgs,
    include: decomposed.host.include,
    exclude: decomposed.host.exclude,
  });

  if (enumerated.files.length === 0) {
    // cli.md §8: "no analyzable input" is one of the reasons a run fails
    // *before* analysis starts — stdout carries zero lines (§7.2); every
    // message here is stderr-only, never routed through the renderer.
    for (const error of enumerated.errors) {
      options.notice(`${formatNoticeFromRunError(error)}\n`);
    }
    options.notice(
      `${
        enumerated.errors.length > 0
          ? "No files left to analyze after resolving the given arguments."
          : "No files matched the given include/exclude patterns."
      }\n`,
    );
    return { interrupted: false, exitCode: EXIT_RUN_ERROR };
  }

  if (!options.workspaceTrusted) {
    options.notice(
      "--untrusted: ignoring workspace validator configuration and external adapters.\n",
    );
  }

  const loadResult = await loadAdaptersForRun({
    validators: decomposed.validators,
    workspaceRoot: options.workspaceRoot,
    workspaceTrusted: options.workspaceTrusted,
    externalAdapters: decomposed.host.externalAdapters,
    moduleResolver: options.moduleResolver,
    builtins: options.builtins,
    logger: options.logger,
  });

  const runLevelErrors: RunLevelError[] = [];
  const reportedKeys = new Set<string>();
  /** cli.md §8: run-level errors are reported once each, keyed per their kind. */
  function reportRunError(error: RunLevelError, dedupeKey: string): void {
    if (reportedKeys.has(dedupeKey)) return;
    reportedKeys.add(dedupeKey);
    runLevelErrors.push(error);
    options.renderer.runError(error);
  }

  const analyzer = await createWorkspaceAnalyzer({
    workspaceRoot: options.workspaceRoot,
    adapters: loadResult.adapters,
    generateOptions: decomposed.generateOptions,
    maxConcurrency: decomposed.analyzer.maxConcurrency,
    logger: options.logger,
  });

  const counts: RunSummaryCounts = {
    filesAnalyzed: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    hints: 0,
    runErrors: 0,
  };
  let hasThresholdDiagnostic = false;

  try {
    // A run that reaches here *is* reaching analysis — emit the stream's
    // start marker (NDJSON's `meta`; a no-op for text) before anything else,
    // then report the enumeration/adapter-load failures already known.
    options.renderer.start();
    for (const error of enumerated.errors) {
      reportRunError(error, `enumerate:${error.message}`);
    }
    for (const failure of loadResult.failures) {
      reportRunError(
        { code: `adapter-load/${failure.kind}`, message: failure.message },
        `adapter-load:${failure.dedupeKey}`,
      );
    }

    for (const absolutePath of enumerated.files) {
      if (options.signal.aborted) break;
      const relPath = toWorkspaceRelativePosix(
        options.workspaceRoot,
        absolutePath,
      );

      let source: string;
      try {
        source = await readFile(absolutePath, "utf8");
      } catch (error) {
        reportRunError(
          {
            code: "file-unreadable",
            message: `Failed to read "${relPath}": ${errorMessage(error)}`,
            path: relPath,
          },
          `file-read:${relPath}`,
        );
        continue;
      }

      let result;
      try {
        result = await analyzer.analyze({
          uri: toFileUri(absolutePath),
          filename: absolutePath,
          source,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal.aborted) break; // cancellation is not a diagnostic
        reportRunError(
          {
            code: "internal-error",
            message: `Analysis failed for "${relPath}": ${errorMessage(error)}`,
            path: relPath,
          },
          `internal:${relPath}`,
        );
        continue;
      }
      // A result that completed just as the signal fired is discarded, not
      // rendered (cli.md §6: "cancellation is not a diagnostic").
      if (options.signal.aborted) break;

      const index = createLineIndex(source);
      const perFileDiagnostics: SourceDiagnostic[] = [];
      for (const diagnostic of result.diagnostics) {
        if (isSessionFailureDiagnostic(diagnostic)) {
          // cli.md §8: the analyzer places this on every analyzed file; the
          // CLI reports it once at run level and drops it from the file's
          // own diagnostics list.
          reportRunError(
            {
              code: diagnostic.code,
              message: diagnostic.message,
              ...(diagnostic.adapterId !== undefined
                ? { adapterId: diagnostic.adapterId }
                : {}),
            },
            `session:${diagnostic.adapterId ?? ""}:${diagnostic.code}`,
          );
          continue;
        }
        perFileDiagnostics.push(diagnostic);
      }

      const projected: readonly CliDiagnostic[] = sortCliDiagnostics(
        perFileDiagnostics.map((diagnostic) =>
          projectDiagnostic(diagnostic, index, relPath),
        ),
      );
      for (const diagnostic of projected) {
        tallySeverity(counts, diagnostic.severity);
        if (severityMeetsThreshold(diagnostic.severity, options.failOn)) {
          hasThresholdDiagnostic = true;
        }
      }
      counts.filesAnalyzed += 1;
      options.renderer.file(relPath, projected);
    }
  } finally {
    await disposeBounded(analyzer);
  }

  if (options.signal.aborted) {
    // cli.md §7.2: no `summary` line on interruption — the caller (bin.ts)
    // knows which signal fired and picks 130/143.
    return { interrupted: true };
  }

  counts.runErrors = runLevelErrors.length;
  options.renderer.summary(counts);

  return {
    interrupted: false,
    exitCode: computeExitCode({
      hasRunLevelError: runLevelErrors.length > 0,
      hasThresholdDiagnostic,
    }),
  };
}

function tallySeverity(
  counts: RunSummaryCounts,
  severity: CliDiagnostic["severity"],
): void {
  switch (severity) {
    case "error":
      counts.errors += 1;
      break;
    case "warning":
      counts.warnings += 1;
      break;
    case "info":
      counts.infos += 1;
      break;
    case "hint":
      counts.hints += 1;
      break;
  }
}

function toWorkspaceRelativePosix(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * cli.md §6 step 3: `AnalyzeRequest.uri` is built from the resolved absolute
 * real path with Node's `pathToFileURL` — its Windows drive-letter and
 * percent-encoding rules *are* the contract, so this is a thin, exported
 * wrapper (not a reimplementation) kept testable at the module boundary.
 */
export function toFileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatNoticeFromRunError(error: RunLevelError): string {
  return `error: ${error.message} (${error.code})`;
}

async function disposeBounded(analyzer: WorkspaceAnalyzer): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolvePromise) => {
    timer = setTimeout(resolvePromise, DISPOSE_TIMEOUT_MS);
    timer.unref();
  });
  try {
    await Promise.race([analyzer.dispose(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
