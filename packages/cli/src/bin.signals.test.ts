// cli.md §9 item 11 (the real-OS-signal half; the deterministic
// abort-propagation half — no partial rendering, sessions disposed, NDJSON
// stream stops with no summary line — lives in runner.test.ts via a
// controllable fake adapter, per cli.md's own guidance that either approach
// is acceptable). This spawns the *built* CLI (`dist/bin.js`) as a real
// child process and sends it real SIGINT/SIGTERM signals — skipped
// gracefully when the package hasn't been built yet (this repo's
// verification flow always builds before testing; a bare `vitest run`
// without a prior build should not hard-fail here).
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const BIN_PATH = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const BUILT = existsSync(BIN_PATH);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function largeWorkspace(fileCount: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vhb-cli-signals-"));
  tempDirs.push(dir);
  for (let i = 0; i < fileCount; i += 1) {
    await writeFile(
      join(dir, `Component${i}.vue`),
      `<template><div id="c${i}">component ${i}</div></template>`,
    );
  }
  return dir;
}

interface SpawnedRun {
  child: ChildProcessWithoutNullStreams;
  firstLine: Promise<void>;
  stdout: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnCli(args: readonly string[], cwd: string): SpawnedRun {
  const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd });
  const stdout: string[] = [];
  let resolveFirstLine: () => void;
  const firstLine = new Promise<void>((resolve) => {
    resolveFirstLine = resolve;
  });
  let sawFirstLine = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
    if (!sawFirstLine && stdout.join("").includes("\n")) {
      sawFirstLine = true;
      resolveFirstLine();
    }
  });
  child.stderr.resume(); // drain, don't care about content here

  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return { child, firstLine, stdout, exit };
}

describe.skipIf(!BUILT)(
  "bin.js: real SIGINT/SIGTERM handling (cli.md §6 'Signals', §9 item 11)",
  () => {
    it("SIGINT mid-run: exits 130, and stdout has no trailing summary line", async () => {
      const root = await largeWorkspace(80);
      const run = spawnCli(["--format", "ndjson"], root);
      await run.firstLine; // analysis has genuinely started
      run.child.kill("SIGINT");
      const { code } = await run.exit;
      expect(code).toBe(130);
      const lines = run.stdout
        .join("")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      const last = JSON.parse(lines.at(-1)!) as { type: string };
      expect(last.type).not.toBe("summary");
    }, 15000);

    it("SIGTERM mid-run: exits 143", async () => {
      const root = await largeWorkspace(80);
      const run = spawnCli(["--format", "ndjson"], root);
      await run.firstLine;
      run.child.kill("SIGTERM");
      const { code } = await run.exit;
      expect(code).toBe(143);
    }, 15000);

    it("a second signal in quick succession still results in a prompt exit (no hang, no crash)", async () => {
      // This proves the double-signal path doesn't hang or produce an
      // unexpected exit code; it does not independently distinguish
      // "graceful-but-fast" from "forced-immediate" timing, since a real,
      // cooperative adapter's own abort response is already fast (bounded
      // by core.md §2's own measured cancellation latency) — see the module
      // doc comment.
      const root = await largeWorkspace(150);
      const run = spawnCli(["--format", "ndjson"], root);
      await run.firstLine;
      run.child.kill("SIGINT");
      run.child.kill("SIGINT");
      const started = Date.now();
      const { code } = await run.exit;
      expect(code).toBe(130);
      expect(Date.now() - started).toBeLessThan(10000);
    }, 15000);
  },
);
