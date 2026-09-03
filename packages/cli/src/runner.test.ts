// cli.md §9 items 5 (URI construction), 9 (run outcome model), 10 (exit
// codes), 11 (signals/abort propagation). Uses real temp directories, a
// real WorkspaceAnalyzer (via runCli's real loadAdaptersForRun/
// createWorkspaceAnalyzer wiring), and adapter-testkit's fake/no-blink
// adapters injected through the `builtins` map — the same "real except for
// a deliberate failure injection" discipline as
// packages/language-server/src/e2e.test.ts.
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdapter } from "@vue-html-bridge/adapter-testkit/fake";
import { createNoBlinkAdapter } from "@vue-html-bridge/adapter-testkit";
import type { ResolvedVueHtmlBridgeSettings } from "@vue-html-bridge/settings";
import type {
  DiagnosticSeverity,
  HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";
import * as emitHtml from "./emit-html.js";
import { createNdjsonRenderer, type CliNdjsonRecord } from "./output/ndjson.js";
import { runCli, toFileUri } from "./runner.js";
import type {
  CliDiagnostic,
  OutputRenderer,
  RunLevelError,
  RunSummaryCounts,
} from "./types.js";

// plan.md T5 REQ-8 negative test: spies wrap the *real* implementation
// (importOriginal) so every other test in this file still gets real disk
// behavior — only the --emit-html describe block below asserts on calls.
vi.mock("./emit-html.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./emit-html.js")>();
  return {
    ...actual,
    prepareEmitHtmlDir: vi.fn(actual.prepareEmitHtmlDir),
    writeVariantArtifacts: vi.fn(actual.writeVariantArtifacts),
  };
});

const tempDirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Real path (see enumerate.test.ts's identical helper doc comment: runCli's own workspace-relative path math assumes an already-canonical root, matching cli.ts's top-level realpath()). */
async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vhb-cli-runner-"));
  tempDirs.push(dir);
  return realpath(dir);
}

function baseSettings(
  overrides: Partial<ResolvedVueHtmlBridgeSettings> = {},
): ResolvedVueHtmlBridgeSettings {
  return {
    enabled: true,
    include: ["**/*.vue"],
    exclude: ["**/node_modules/**"],
    validateOnChange: true,
    validateOnSave: true,
    debounceMs: 200,
    maxConcurrency: undefined,
    warnVariantCount: undefined,
    customElements: [],
    customDirectives: [],
    externalAdapters: "disabled",
    validators: [{ adapter: "markuplint", enabled: true }],
    ...overrides,
  };
}

interface RecordingRenderer extends OutputRenderer {
  events: string[];
  files: { path: string; diagnostics: readonly CliDiagnostic[] }[];
  runErrors: RunLevelError[];
  summaries: RunSummaryCounts[];
}

function recordingRenderer(): RecordingRenderer {
  const events: string[] = [];
  const files: { path: string; diagnostics: readonly CliDiagnostic[] }[] = [];
  const runErrors: RunLevelError[] = [];
  const summaries: RunSummaryCounts[] = [];
  return {
    events,
    files,
    runErrors,
    summaries,
    start() {
      events.push("start");
    },
    file(path, diagnostics) {
      events.push(`file:${path}`);
      files.push({ path, diagnostics });
    },
    runError(error) {
      events.push(`runError:${error.code}`);
      runErrors.push(error);
    },
    summary(counts) {
      events.push("summary");
      summaries.push(counts);
    },
  };
}

describe("toFileUri (cli.md §6 step 3, §9 item 5: URI construction)", () => {
  it("is pathToFileURL-based and stable for the same file within a run", () => {
    const path = "/workspace/src/Component.vue";
    expect(toFileUri(path)).toBe(pathToFileURL(path).href);
    expect(toFileUri(path)).toBe(toFileUri(path));
  });

  it("percent-encodes special characters (space, non-ASCII) exactly as pathToFileURL does", () => {
    // This environment is POSIX-only; genuine Windows drive-letter behavior
    // (the other half of cli.md §9 item 5) is not verifiable here without a
    // Windows host — the CLI delegates that entirely to Node's own
    // `pathToFileURL`, which is the documented contract (cli.md §6 step 3),
    // rather than a CLI-specific reimplementation to test independently.
    const path = "/workspace/src/My Component é.vue";
    expect(toFileUri(path)).toBe(pathToFileURL(path).href);
    expect(toFileUri(path)).toContain("%20");
  });

  it("two different files in the same run get different, correctly distinguishing URIs", () => {
    expect(toFileUri("/workspace/A.vue")).not.toBe(
      toFileUri("/workspace/B.vue"),
    );
  });
});

describe("runCli: run outcome model (cli.md §8, §9 item 9)", () => {
  it("a session-level adapter failure is reported once at run level, not repeated per file; other adapter/files survive; exit 2", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div></div></template>");
    await writeFile(join(root, "B.vue"), "<template><div></div></template>");

    const working = createFakeAdapter({ id: "working" });
    working.enqueue({
      diagnostics: [
        {
          ruleId: "found",
          severity: "warning",
          message: "found it",
          range: { start: 0, end: 1 },
        },
      ],
      failures: [],
    });
    working.enqueue({ diagnostics: [], failures: [] });
    const failing = createNoBlinkAdapter();

    const renderer = recordingRenderer();
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({
        validators: [
          { adapter: "working", enabled: true },
          {
            adapter: "failing",
            enabled: true,
            settings: { failOnCreate: true },
          },
        ],
      }),
      workspaceTrusted: true,
      failOn: "error",
      signal: new AbortController().signal,
      renderer,
      notice: () => {},
      builtins: new Map<string, HtmlValidatorAdapter<unknown>>([
        ["working", working.adapter],
        ["failing", failing],
      ]),
    });

    expect(result).toEqual({ interrupted: false, exitCode: 2 });
    // The diagnostic code embeds the adapter's *runtime* id ("no-blink",
    // createNoBlinkAdapter's own `id`), not the settings entry key
    // ("failing") used to configure it — exactly the distinction cli.md
    // §4.3 draws between entry-key addressing and runtime adapter.id.
    // Reported exactly once, even though it recurs on every analyzed file.
    const sessionFailures = renderer.runErrors.filter((e) =>
      e.code.startsWith("adapter/no-blink/"),
    );
    expect(sessionFailures).toHaveLength(1);
    expect(sessionFailures[0]!.code).toBe(
      "adapter/no-blink/configuration-error",
    );
    // Both files still got analyzed, and the working adapter's diagnostic survived.
    expect(renderer.files.map((f) => f.path).sort()).toEqual([
      "A.vue",
      "B.vue",
    ]);
    const withDiagnostics = renderer.files.find(
      (f) => f.diagnostics.length > 0,
    );
    expect(withDiagnostics).toBeDefined();
    // The session-failure diagnostic itself must not leak into any file's own list.
    for (const file of renderer.files) {
      expect(
        file.diagnostics.some((d) =>
          (d as { code: string }).code.startsWith("adapter/no-blink/"),
        ),
      ).toBe(false);
    }
    expect(renderer.summaries[0]!.runErrors).toBe(1);
  });

  it("a file read error is a run-level error; remaining files are still analyzed; exit 2", async () => {
    const root = await tempWorkspace();
    const brokenPath = join(root, "Broken.vue");
    await writeFile(brokenPath, "<template><div></div></template>");
    await writeFile(join(root, "Fine.vue"), "<template><div></div></template>");
    const isRoot = process.getuid?.() === 0;
    if (!isRoot) await chmod(brokenPath, 0o000);

    try {
      const renderer = recordingRenderer();
      const result = await runCli({
        workspaceRoot: root,
        cwd: root,
        positionalArgs: [],
        settings: baseSettings({ validators: [] }),
        workspaceTrusted: true,
        failOn: "error",
        signal: new AbortController().signal,
        renderer,
        notice: () => {},
      });

      if (isRoot) return; // root bypasses file permissions; nothing to assert
      expect(result).toEqual({ interrupted: false, exitCode: 2 });
      expect(renderer.runErrors.some((e) => e.code === "file-unreadable")).toBe(
        true,
      );
      expect(renderer.files.map((f) => f.path)).toEqual(["Fine.vue"]);
    } finally {
      if (!isRoot) await chmod(brokenPath, 0o644);
    }
  });

  it("no run-level error and no diagnostic at/above the threshold: exit 0", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, "Clean.vue"),
      "<template><div></div></template>",
    );
    const renderer = recordingRenderer();
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({ validators: [] }),
      workspaceTrusted: true,
      failOn: "error",
      signal: new AbortController().signal,
      renderer,
      notice: () => {},
    });
    expect(result).toEqual({ interrupted: false, exitCode: 0 });
    expect(renderer.summaries[0]).toMatchObject({ runErrors: 0, errors: 0 });
  });
});

describe("runCli: --fail-on threshold interactions (cli.md §8, §9 item 10)", () => {
  async function runWithSeverities(options: {
    severities: readonly DiagnosticSeverity[];
    failOn: "error" | "warning" | "info" | "hint" | "never";
    verbose?: boolean;
  }) {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div></div></template>");
    const fake = createFakeAdapter({ id: "fake" });
    fake.enqueue({
      diagnostics: options.severities.map((severity) => ({
        ruleId: `rule-${severity}`,
        severity,
        message: `a ${severity} diagnostic`,
        range: { start: 0, end: 1 },
      })),
      failures: [],
    });
    const renderer = recordingRenderer();
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({
        validators: [{ adapter: "fake", enabled: true }],
      }),
      workspaceTrusted: true,
      failOn: options.failOn,
      verbose: options.verbose,
      signal: new AbortController().signal,
      renderer,
      notice: () => {},
      builtins: new Map([["fake", fake.adapter]]),
    });
    return { renderer, result };
  }

  async function runWithWarningDiagnostic(
    failOn: "error" | "warning" | "info" | "hint" | "never",
  ) {
    const { result } = await runWithSeverities({
      severities: ["warning"],
      failOn,
    });
    return result;
  }

  it("--fail-on warning: a warning diagnostic triggers exit 1", async () => {
    expect(await runWithWarningDiagnostic("warning")).toEqual({
      interrupted: false,
      exitCode: 1,
    });
  });

  it("--fail-on error (default): a warning-only run exits 0", async () => {
    expect(await runWithWarningDiagnostic("error")).toEqual({
      interrupted: false,
      exitCode: 0,
    });
  });

  it("--fail-on never: exits 0 regardless of diagnostics", async () => {
    expect(await runWithWarningDiagnostic("never")).toEqual({
      interrupted: false,
      exitCode: 0,
    });
  });

  it("without --verbose, renders and counts only errors and warnings", async () => {
    const { renderer, result } = await runWithSeverities({
      severities: ["error", "warning", "info", "hint"],
      failOn: "never",
    });

    expect(result).toEqual({ interrupted: false, exitCode: 0 });
    expect(renderer.files).toHaveLength(1);
    expect(
      renderer.files[0]!.diagnostics.map(({ severity }) => severity),
    ).toEqual(["error", "warning"]);
    expect(renderer.summaries[0]).toEqual({
      filesAnalyzed: 1,
      errors: 1,
      warnings: 1,
      infos: 0,
      hints: 0,
      runErrors: 0,
    });
  });

  it("with --verbose, renders and counts all diagnostic severities", async () => {
    const { renderer, result } = await runWithSeverities({
      severities: ["error", "warning", "info", "hint"],
      failOn: "never",
      verbose: true,
    });

    expect(result).toEqual({ interrupted: false, exitCode: 0 });
    expect(renderer.files).toHaveLength(1);
    expect(
      renderer.files[0]!.diagnostics.map(({ severity }) => severity),
    ).toEqual(["error", "warning", "info", "hint"]);
    expect(renderer.summaries[0]).toEqual({
      filesAnalyzed: 1,
      errors: 1,
      warnings: 1,
      infos: 1,
      hints: 1,
      runErrors: 0,
    });
  });

  it.each(["info", "hint"] as const)(
    "a hidden %s diagnostic does not meet the fail-on threshold unless --verbose is set",
    async (severity) => {
      const hidden = await runWithSeverities({
        severities: [severity],
        failOn: severity,
      });
      expect(hidden.result).toEqual({ interrupted: false, exitCode: 0 });
      expect(hidden.renderer.files[0]!.diagnostics).toEqual([]);

      const visible = await runWithSeverities({
        severities: [severity],
        failOn: severity,
        verbose: true,
      });
      expect(visible.result).toEqual({ interrupted: false, exitCode: 1 });
      expect(visible.renderer.files[0]!.diagnostics).toHaveLength(1);
    },
  );
});

describe("runCli: enumeration boundary violations and empty results (cli.md §6, §8)", () => {
  it("no analyzable input is a pre-analysis fatal: exit 2, renderer never started", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "README.md"), "not a vue file");
    const renderer = recordingRenderer();
    const notices: string[] = [];
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings(),
      workspaceTrusted: true,
      failOn: "error",
      signal: new AbortController().signal,
      renderer,
      notice: (message) => notices.push(message),
    });
    expect(result).toEqual({ interrupted: false, exitCode: 2 });
    expect(renderer.events).toEqual([]); // start() never called
    expect(notices.join("")).toContain("No files matched");
  });
});

describe("runCli: signal abort propagation (cli.md §6 'Signals', §9 item 11)", () => {
  it("aborting mid-analysis discards the in-flight file, skips remaining files, disposes sessions, and reports interrupted", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div></div></template>");
    await writeFile(join(root, "B.vue"), "<template><div></div></template>");

    const fake = createFakeAdapter({ id: "slow" });
    // Deliberately never resolved on its own: the abort must propagate
    // through the whole runner -> analyzer -> adapter chain, exactly like
    // language-server's e2e cancellation test (adapter-testkit's
    // abortable()), not by the barrier ever settling.
    fake.blockNext();

    const controller = new AbortController();
    const renderer = recordingRenderer();
    const runPromise = runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({
        validators: [{ adapter: "slow", enabled: true }],
      }),
      workspaceTrusted: true,
      failOn: "error",
      signal: controller.signal,
      renderer,
      notice: () => {},
      builtins: new Map([["slow", fake.adapter]]),
    });

    const deadline = Date.now() + 2000;
    while (fake.calls.length === 0) {
      if (Date.now() > deadline) throw new Error("validate() never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();

    const result = await runPromise;
    expect(result).toEqual({ interrupted: true });
    // Only start() fired — no file, runError, or summary was ever rendered
    // for the file that was in flight when the signal arrived.
    expect(renderer.events).toEqual(["start"]);
    expect(fake.disposeCount).toBe(1);
  });

  it("in NDJSON mode, an interrupted run's stream has meta but no trailing summary line", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div></div></template>");

    const fake = createFakeAdapter({ id: "slow" });
    fake.blockNext();
    const controller = new AbortController();
    const lines: string[] = [];
    const renderer = createNdjsonRenderer((chunk) => lines.push(chunk));

    const runPromise = runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({
        validators: [{ adapter: "slow", enabled: true }],
      }),
      workspaceTrusted: true,
      failOn: "error",
      signal: controller.signal,
      renderer,
      notice: () => {},
      builtins: new Map([["slow", fake.adapter]]),
    });

    const deadline = Date.now() + 2000;
    while (fake.calls.length === 0) {
      if (Date.now() > deadline) throw new Error("validate() never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await runPromise;

    const records = lines.map((line) => JSON.parse(line) as CliNdjsonRecord);
    expect(records[0]).toEqual({ type: "meta", version: 2 });
    expect(records.some((record) => record.type === "summary")).toBe(false);
  });
});

describe("runCli: --emit-html wiring (plan.md T5)", () => {
  it("writes variant artifacts per analyzed file and emits the one-line stderr notice, when emitHtmlDir is set", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div>x</div></template>");
    const outDir = join(
      root,
      "..",
      "emit-out-" + Math.random().toString(36).slice(2),
    );
    tempDirs.push(outDir);

    const notices: string[] = [];
    const renderer = recordingRenderer();
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({ validators: [] }),
      workspaceTrusted: true,
      failOn: "error",
      signal: new AbortController().signal,
      renderer,
      notice: (message) => notices.push(message),
      builtins: new Map(),
      emitHtmlDir: outDir,
    });

    expect(result).toEqual({ interrupted: false, exitCode: 0 });
    expect(emitHtml.prepareEmitHtmlDir).toHaveBeenCalledWith(outDir);
    expect(emitHtml.writeVariantArtifacts).toHaveBeenCalledTimes(1);
    expect(notices.some((n) => n.includes("--emit-html"))).toBe(true);

    // The hash segment isn't known ahead of time — read it back off disk.
    const written = await readdir(join(outDir, "A.vue.__vue_html_bridge__"));
    expect(written.some((name) => name.endsWith(".html"))).toBe(true);
    expect(written.some((name) => name.endsWith(".json"))).toBe(true);
    const htmlFile = written.find((name) => name.endsWith(".html"))!;
    expect(
      await readFile(
        join(outDir, "A.vue.__vue_html_bridge__", htmlFile),
        "utf8",
      ),
    ).toBe("<div>x</div>");
  });

  it("REQ-8 negative case: neither prepareEmitHtmlDir nor writeVariantArtifacts is ever called when emitHtmlDir is omitted", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div>x</div></template>");

    const renderer = recordingRenderer();
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({ validators: [] }),
      workspaceTrusted: true,
      failOn: "error",
      signal: new AbortController().signal,
      renderer,
      notice: () => {},
      builtins: new Map(),
      // emitHtmlDir intentionally omitted.
    });

    expect(result).toEqual({ interrupted: false, exitCode: 0 });
    expect(emitHtml.prepareEmitHtmlDir).not.toHaveBeenCalled();
    expect(emitHtml.writeVariantArtifacts).not.toHaveBeenCalled();
  });

  it("a per-file write failure is reported once as a run-level error, without aborting analysis of the remaining files", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div>x</div></template>");
    await writeFile(join(root, "B.vue"), "<template><div>y</div></template>");
    const outDir = join(
      root,
      "..",
      "emit-fail-" + Math.random().toString(36).slice(2),
    );
    tempDirs.push(outDir);

    vi.mocked(emitHtml.writeVariantArtifacts).mockRejectedValueOnce(
      new Error("disk full"),
    );

    const renderer = recordingRenderer();
    const result = await runCli({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      settings: baseSettings({ validators: [] }),
      workspaceTrusted: true,
      failOn: "error",
      signal: new AbortController().signal,
      renderer,
      notice: () => {},
      builtins: new Map(),
      emitHtmlDir: outDir,
    });

    expect(result).toEqual({ interrupted: false, exitCode: 2 });
    expect(
      renderer.runErrors.some((e) => e.code === "emit-html/write-error"),
    ).toBe(true);
    // Both files still analyzed and rendered — failure isolation.
    expect(renderer.files.map((f) => f.path).sort()).toEqual([
      "A.vue",
      "B.vue",
    ]);
  });
});
