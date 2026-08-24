// Public surface of @vue-html-bridge/cli (cli.md). Nothing inside the
// monorepo depends on this package (monorepo.md §4.1) — these exports exist
// for this package's own tests and for a future programmatic embedder, not
// as a contract another workspace package relies on.
export const PACKAGE_NAME = "@vue-html-bridge/cli";

export {
  runVueHtmlBridgeCli,
  type CliIo,
  type CliInvocationResult,
} from "./cli.js";
export {
  parseArgv,
  HELP_TEXT,
  type OutputFormat,
  type ParsedCliOptions,
  type ParseArgvResult,
  type ValidatorFlagOp,
} from "./options.js";
export { runCli, type RunCliOptions, type RunCliResult } from "./runner.js";
export {
  EXIT_SUCCESS,
  EXIT_THRESHOLD,
  EXIT_RUN_ERROR,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  type FailOnThreshold,
} from "./exit-codes.js";
export type {
  CliDiagnostic,
  RunLevelError,
  RunSummaryCounts,
  OutputRenderer,
} from "./types.js";
export {
  createNdjsonRenderer,
  CLI_NDJSON_VERSION,
  type CliNdjsonRecord,
  type CliNdjsonMeta,
  type CliNdjsonFile,
  type CliNdjsonRunError,
  type CliNdjsonSummary,
  type CliNdjsonDiagnostic,
} from "./output/ndjson.js";
export { createTextRenderer, type TextRendererOptions } from "./output/text.js";
