// Human-readable text output (cli.md §7.1, the default format). One line
// per diagnostic, related information indented beneath it; run-level errors
// go to stderr as they occur; a final summary line goes to stdout.
//
// The exact summary-line wording is not prescribed by cli.md §7.1 (only the
// per-diagnostic block is shown as a literal example) — the format below
// ("N file(s) analyzed: ...") is this implementation's own choice, pinned by
// this package's golden test.
import type {
  CliDiagnostic,
  OutputRenderer,
  RunLevelError,
  RunSummaryCounts,
} from "../types.js";

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function evidenceSuffix(evidence: CliDiagnostic["evidence"]): string {
  const parts: string[] = [];
  if (evidence.variantCount > 1)
    parts.push(`${evidence.variantCount} variants`);
  if (evidence.truncated) parts.push("truncated");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** cli.md §4.2 `--no-color`: ANSI codes for the severity token only, applied by the caller only when color is enabled. */
const SEVERITY_COLOR: Record<CliDiagnostic["severity"], string> = {
  error: "[31m", // red
  warning: "[33m", // yellow
  info: "[36m", // cyan
  hint: "[90m", // gray
};
const ANSI_RESET = "[0m";

function colorize(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI_RESET}` : text;
}

function formatDiagnostic(
  path: string,
  diagnostic: CliDiagnostic,
  color: boolean,
): string {
  const lines: string[] = [];
  const severityToken = colorize(
    diagnostic.severity,
    SEVERITY_COLOR[diagnostic.severity],
    color,
  );
  lines.push(
    `${path}:${diagnostic.position.startLine}:${diagnostic.position.startColumn} ${severityToken} ${diagnostic.code}`,
  );
  const adapterSuffix = diagnostic.adapterId
    ? ` [${diagnostic.adapterId}]`
    : "";
  lines.push(
    `  ${diagnostic.message}${evidenceSuffix(diagnostic.evidence)}${adapterSuffix}`,
  );
  for (const related of diagnostic.relatedInformation) {
    lines.push(
      `    related ${related.path}:${related.position.startLine}:${related.position.startColumn} ${related.message}`,
    );
  }
  return lines.join("\n");
}

function formatRunError(error: RunLevelError, color: boolean): string {
  const location = error.path ? `${error.path}: ` : "";
  const adapterSuffix = error.adapterId ? ` [${error.adapterId}]` : "";
  const prefix = colorize("error", SEVERITY_COLOR.error, color);
  return `${prefix}: ${location}${error.message} (${error.code})${adapterSuffix}`;
}

function formatSummary(counts: RunSummaryCounts): string {
  const parts = [
    pluralize(counts.errors, "error"),
    pluralize(counts.warnings, "warning"),
    pluralize(counts.infos, "info"),
    pluralize(counts.hints, "hint"),
  ];
  const runErrorSuffix =
    counts.runErrors > 0 ? `, ${pluralize(counts.runErrors, "run error")}` : "";
  return `${pluralize(counts.filesAnalyzed, "file")} analyzed: ${parts.join(", ")}${runErrorSuffix}`;
}

export interface TextRendererOptions {
  /** cli.md §4.2: color only when stdout is a TTY and `NO_COLOR` is unset and `--no-color` wasn't given — decided by the caller (cli.ts). Default false. */
  color?: boolean;
}

/**
 * `writeStdout`/`writeStderr` are called with already-newline-terminated
 * chunks; the caller owns the real stream (kept simple/testable, same
 * pattern as output/ndjson.ts).
 */
export function createTextRenderer(
  writeStdout: (chunk: string) => void,
  writeStderr: (chunk: string) => void,
  options: TextRendererOptions = {},
): OutputRenderer {
  const color = options.color ?? false;
  return {
    start() {
      // No start-of-stream marker in text mode.
    },
    file(path, diagnostics) {
      for (const diagnostic of diagnostics) {
        writeStdout(`${formatDiagnostic(path, diagnostic, color)}\n`);
      }
    },
    runError(error) {
      writeStderr(`${formatRunError(error, color)}\n`);
    },
    summary(counts) {
      writeStdout(`${formatSummary(counts)}\n`);
    },
  };
}
