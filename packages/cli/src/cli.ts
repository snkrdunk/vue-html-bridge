// Top-level orchestration (cli.md §11): argument parsing dispatch,
// --help/--version, usage errors, settings sourcing, and handing off to
// runner.ts. bin.ts owns only the real process/stdio/signal wiring; this
// module is what a test drives directly, with injectable I/O.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdapterModuleResolver } from "@vue-html-bridge/adapter-loader";
import type { SettingsIssue } from "@vue-html-bridge/settings";
import type {
  AdapterLogger,
  HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";
import { EXIT_RUN_ERROR, EXIT_SUCCESS } from "./exit-codes.js";
import { HELP_TEXT, parseArgv } from "./options.js";
import { createNdjsonRenderer } from "./output/ndjson.js";
import { createTextRenderer } from "./output/text.js";
import { runCli } from "./runner.js";
import { resolveCliSettings } from "./settings-resolution.js";

export interface CliIo {
  argv: readonly string[];
  /** Absolute. */
  cwd: string;
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
  signal: AbortSignal;
  /** The package's own version, for `--version` (bin.ts reads it from package.json). */
  version: string;
  /** cli.md §4.2: color is used only when stdout is a TTY and `NO_COLOR` is unset (and `--no-color` isn't given). */
  stdoutIsTty?: boolean;
  noColorEnv?: boolean;
  /** Injectable for tests (adapter-loader.md §6 item 8's shared contract fixture, adapter-testkit's fake adapter). */
  moduleResolver?: AdapterModuleResolver;
  builtins?: ReadonlyMap<string, HtmlValidatorAdapter<unknown>>;
  logger?: AdapterLogger;
}

export type CliInvocationResult =
  { interrupted: true } | { interrupted: false; exitCode: number };

function formatSettingsIssue(issue: SettingsIssue): string {
  const location = issue.sourcePath ? `${issue.sourcePath}: ` : "";
  return `${issue.severity}: ${location}${issue.message}`;
}

export async function runVueHtmlBridgeCli(
  io: CliIo,
): Promise<CliInvocationResult> {
  const parsed = parseArgv(io.argv);
  if (parsed.kind === "error") {
    io.writeStderr(`vue-html-bridge: ${parsed.message}\n\n${HELP_TEXT}`);
    return { interrupted: false, exitCode: EXIT_RUN_ERROR };
  }
  const options = parsed.options;

  if (options.help) {
    io.writeStdout(HELP_TEXT);
    return { interrupted: false, exitCode: EXIT_SUCCESS };
  }
  if (options.version) {
    io.writeStdout(`${io.version}\n`);
    return { interrupted: false, exitCode: EXIT_SUCCESS };
  }

  const rawWorkspaceRoot =
    options.workspaceRoot !== undefined
      ? resolve(io.cwd, options.workspaceRoot)
      : io.cwd;

  // Canonicalize once, up front: every downstream absolute-path comparison
  // (enumeration's workspace-boundary check, workspace-relative output
  // paths, the dedup-by-real-path rule in cli.md §6) assumes `workspaceRoot`
  // and `cwd` are already real paths — e.g. on macOS, the OS temp directory
  // is itself a symlink (/var -> /private/var), and comparing an
  // un-resolved root against realpath()-resolved file paths would otherwise
  // produce a spurious "outside the workspace" escape in relative-path math.
  let workspaceRoot: string;
  let cwd: string;
  try {
    [workspaceRoot, cwd] = await Promise.all([
      realpath(rawWorkspaceRoot),
      realpath(io.cwd),
    ]);
  } catch (error) {
    io.writeStderr(
      `vue-html-bridge: error: could not resolve the workspace root "${rawWorkspaceRoot}": ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return { interrupted: false, exitCode: EXIT_RUN_ERROR };
  }

  // Resolved against workspaceRoot, not cwd, consistent with cli.md §4.2's
  // documented role for --workspace-root ("relative output paths") — the
  // same convention this plan (test-specs.md's flagged relative-dir
  // assumption, resolved here during implementation) extends to
  // --emit-html. Not realpath()'d: the directory need not exist yet
  // (prepareEmitHtmlDir creates it, plan.md Q4), matching the existing
  // "the path does not need to exist on the filesystem" contract for
  // virtualFilename (analyzer.md §5.2).
  const emitHtmlDir =
    options.emitHtmlDir !== undefined
      ? resolve(workspaceRoot, options.emitHtmlDir)
      : undefined;

  const settingsResult = await resolveCliSettings({
    workspaceRoot,
    cwd,
    configPath: options.configPath,
    flagsInput: options.settingsInput,
    validatorOps: options.validatorOps,
    untrusted: options.untrusted,
  });

  if (settingsResult.kind === "fatal") {
    for (const issue of settingsResult.issues) {
      io.writeStderr(`${formatSettingsIssue(issue)}\n`);
    }
    return { interrupted: false, exitCode: EXIT_RUN_ERROR };
  }
  for (const warning of settingsResult.warnings) {
    io.writeStderr(`${formatSettingsIssue(warning)}\n`);
  }

  const color =
    !options.noColor && io.stdoutIsTty === true && io.noColorEnv !== true;
  const renderer =
    options.format === "ndjson"
      ? createNdjsonRenderer(io.writeStdout)
      : createTextRenderer(io.writeStdout, io.writeStderr, { color });

  const result = await runCli({
    workspaceRoot,
    cwd,
    positionalArgs: options.positionalArgs,
    settings: settingsResult.settings,
    workspaceTrusted: settingsResult.workspaceTrusted,
    failOn: options.failOn,
    verbose: options.verbose,
    signal: io.signal,
    renderer,
    notice: io.writeStderr,
    emitHtmlDir,
    moduleResolver: io.moduleResolver,
    builtins: io.builtins,
    logger: io.logger,
  });

  if (result.interrupted) return { interrupted: true };
  return { interrupted: false, exitCode: result.exitCode };
}
