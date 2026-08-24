#!/usr/bin/env node
// Process entry point (cli.md §2, §6 "Signals"): wires real stdio, reads the
// package's own version for `--version`, and handles SIGINT/SIGTERM —
// abort the in-flight run through an AbortSignal, bounded cleanup (runner.ts
// owns the actual dispose bound), exit 130/143, and a second signal during
// cleanup exits immediately. stdout carries analysis results only; logs,
// progress, and notices go to stderr (mirrors the language server's rule).
import { createRequire } from "node:module";
import { runVueHtmlBridgeCli } from "./cli.js";
import { EXIT_SIGINT, EXIT_SIGTERM } from "./exit-codes.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const controller = new AbortController();
let signalCount = 0;
/** Set once, by whichever of SIGINT/SIGTERM fires first — that is the exit code used once the aborted run actually stops (cli.md §6). */
let firstSignalExitCode: number | undefined;

function onSignal(exitCode: number): void {
  signalCount += 1;
  if (signalCount === 1) {
    firstSignalExitCode = exitCode;
    controller.abort();
    return;
  }
  // A second signal during cleanup exits immediately (cli.md §6), using
  // whichever code corresponds to *this* second signal.
  process.exit(exitCode);
}

process.on("SIGINT", () => onSignal(EXIT_SIGINT));
process.on("SIGTERM", () => onSignal(EXIT_SIGTERM));

async function main(): Promise<void> {
  const result = await runVueHtmlBridgeCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    writeStdout(chunk) {
      process.stdout.write(chunk);
    },
    writeStderr(chunk) {
      process.stderr.write(chunk);
    },
    signal: controller.signal,
    version: packageJson.version,
    stdoutIsTty: process.stdout.isTTY === true,
    noColorEnv: process.env["NO_COLOR"] !== undefined,
  });

  if (result.interrupted) {
    process.exit(firstSignalExitCode ?? EXIT_SIGINT);
  }
  process.exit(result.exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `vue-html-bridge: internal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
});
