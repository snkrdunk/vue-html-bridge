// Shared internal types used across runner.ts and the output/ renderers,
// factored out so the output modules never need to import runner.ts (cli.md
// §11: "output modules take fully converted positions and never see the
// analyzer types beyond SourceDiagnostic").

/** cli.md §7.2 `CliNdjsonDiagnostic`, and the shape `--format text` renders from. */
export interface CliDiagnosticRange {
  start: number;
  end: number;
}

export interface CliDiagnosticPosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CliDiagnosticRelated {
  /** Workspace-relative, "/"-separated. */
  path: string;
  range: CliDiagnosticRange;
  position: CliDiagnosticPosition;
  message: string;
}

export interface CliDiagnosticEvidence {
  variantCount: number;
  truncated: boolean;
}

export interface CliDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  origin: "core" | "validator" | "adapter";
  adapterId?: string;
  codeDescriptionHref?: string;
  range: CliDiagnosticRange;
  position: CliDiagnosticPosition;
  relatedInformation: readonly CliDiagnosticRelated[];
  evidence: CliDiagnosticEvidence;
}

/**
 * cli.md §8: a problem with the run itself, distinct from a diagnostic.
 * Reported once each (deduplicated by the caller), regardless of format.
 */
export interface RunLevelError {
  /** e.g. "adapter/markuplint/configuration-error", "file-unreadable", "adapter-load/invalid-shape". */
  code: string;
  message: string;
  adapterId?: string;
  /** Workspace-relative, "/"-separated, when the error is file-scoped. */
  path?: string;
}

export interface RunSummaryCounts {
  filesAnalyzed: number;
  /** Counts reflect diagnostics visible under the current verbosity policy. */
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  runErrors: number;
}

/**
 * The streaming contract both `output/text.ts` and `output/ndjson.ts`
 * implement (cli.md §6 step 5, §7): `runner.ts` renders each file's result
 * as it completes rather than buffering the whole run, and is otherwise
 * agnostic to the chosen format. Each renderer owns where a given call ends
 * up (stdout vs. stderr) — text sends `runError` to stderr (§7.1), NDJSON
 * sends it to stdout as a `runError` record (§7.2) — so `runner.ts` never
 * writes to a stream directly.
 */
export interface OutputRenderer {
  /** Emitted once, only for a run that reaches analysis (NDJSON's `meta` line; a no-op for text). */
  start(): void;
  /** One call per file, in completion order, with diagnostics already sorted (diagnostics.ts). */
  file(path: string, diagnostics: readonly CliDiagnostic[]): void;
  /** One call per run-level error, as it occurs (already deduplicated by the caller). */
  runError(error: RunLevelError): void;
  /** Called once, at the very end, only when the run completed without interruption. */
  summary(counts: RunSummaryCounts): void;
}
