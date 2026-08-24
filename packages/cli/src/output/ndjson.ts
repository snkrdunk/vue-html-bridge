// NDJSON output (cli.md §7.2): one self-contained JSON value per line,
// `\n`-terminated, UTF-8, no pretty-printing, tagged by a `type`
// discriminant. This module owns the normative `CliNdjsonRecord` shapes and
// turns each streaming call from runner.ts into one flushed line — lines are
// written as they are produced, never buffered, which is the entire point of
// choosing NDJSON over a single buffered document (§7.2 "stdout validity").
import type {
  CliDiagnostic,
  OutputRenderer,
  RunLevelError,
  RunSummaryCounts,
} from "../types.js";

export const CLI_NDJSON_VERSION = 1;

/** Always the first line of any run that reaches analysis. */
export interface CliNdjsonMeta {
  type: "meta";
  version: 1;
}

export interface CliNdjsonDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  origin: "core" | "validator" | "adapter";
  adapterId?: string;
  codeDescriptionHref?: string;
  /** UTF-16 offsets into the SFC. */
  range: { start: number; end: number };
  position: {
    /** 1-based. */
    startLine: number;
    /** 1-based; UTF-16 units. */
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  relatedInformation: readonly {
    path: string;
    range: { start: number; end: number };
    position: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    };
    message: string;
  }[];
  evidence: { variantCount: number; truncated: boolean };
}

/** One per file, emitted as that file's analysis completes. */
export interface CliNdjsonFile {
  type: "file";
  /** Workspace-relative, "/"-separated. */
  path: string;
  diagnostics: readonly CliNdjsonDiagnostic[];
}

/** One per run-level error (cli.md §8), emitted as it occurs. */
export interface CliNdjsonRunError {
  type: "runError";
  code: string;
  message: string;
  adapterId?: string;
  /** Workspace-relative, when the error is file-scoped. */
  path?: string;
}

/** Emitted once, last, only if the run reaches completion (§7.2 stdout validity). */
export interface CliNdjsonSummary {
  type: "summary";
  filesAnalyzed: number;
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  runErrors: number;
}

export type CliNdjsonRecord =
  CliNdjsonMeta | CliNdjsonFile | CliNdjsonRunError | CliNdjsonSummary;

function toNdjsonDiagnostic(diagnostic: CliDiagnostic): CliNdjsonDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    origin: diagnostic.origin,
    ...(diagnostic.adapterId !== undefined
      ? { adapterId: diagnostic.adapterId }
      : {}),
    ...(diagnostic.codeDescriptionHref !== undefined
      ? { codeDescriptionHref: diagnostic.codeDescriptionHref }
      : {}),
    range: diagnostic.range,
    position: diagnostic.position,
    relatedInformation: diagnostic.relatedInformation.map((related) => ({
      path: related.path,
      range: related.range,
      position: related.position,
      message: related.message,
    })),
    evidence: diagnostic.evidence,
  };
}

function writeLine(
  write: (chunk: string) => void,
  record: CliNdjsonRecord,
): void {
  write(`${JSON.stringify(record)}\n`);
}

/**
 * `write` is called once per emitted line (already `\n`-terminated) — the
 * caller (runner.ts via bin.ts) is responsible for the actual stdout stream;
 * this keeps the module trivially testable without a real stream.
 */
export function createNdjsonRenderer(
  write: (chunk: string) => void,
): OutputRenderer {
  return {
    start() {
      writeLine(write, { type: "meta", version: CLI_NDJSON_VERSION });
    },
    file(path, diagnostics) {
      writeLine(write, {
        type: "file",
        path,
        diagnostics: diagnostics.map(toNdjsonDiagnostic),
      });
    },
    runError(error: RunLevelError) {
      writeLine(write, {
        type: "runError",
        code: error.code,
        message: error.message,
        ...(error.adapterId !== undefined
          ? { adapterId: error.adapterId }
          : {}),
        ...(error.path !== undefined ? { path: error.path } : {}),
      });
    },
    summary(counts: RunSummaryCounts) {
      writeLine(write, { type: "summary", ...counts });
    },
  };
}
