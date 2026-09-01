// Real, end-to-end coverage against a real temp directory, real files, and
// the real WorkspaceAnalyzer + built-in Markuplint adapter (no mocking,
// matching packages/language-server/src/e2e.test.ts's discipline) — driven
// through the public runVueHtmlBridgeCli entry point exactly the way the
// built CLI itself would be invoked.
//
// Covers cli.md §9 item 7 (NDJSON goldens: clean and exit-2 shapes — the
// interrupted shape is covered in runner.test.ts, where the abort is
// deterministically triggered via a controllable fake adapter), item 6 (text
// golden against a real fixture, complementing output/text.test.ts's unit
// golden), item 12 (--untrusted end-to-end), and the CLI-only half of item
// 14 (E2E parity): the cross-host (CLI + language server in one test file)
// parity test is the one item 9 permits skipping when it would create an
// awkward cross-package test dependency — packages/language-server has no
// reciprocal dependency on packages/cli (monorepo.md §4.1: "nothing inside
// the monorepo depends on the CLI"), and pulling the language server into
// this package's devDependencies purely for one shared test would be exactly
// that kind of dependency. What's missing relative to the full item 14: a
// single test file that starts both a WorkspaceAnalyzer-backed LSP session
// and a CLI run side by side and diffs their diagnostics automatically. In
// its place, this file independently verifies the CLI alone reports the
// exact same diagnostic (code, position) that language-server's own
// "13.2-2/13.3" test asserts for this identical fixture — so a regression in
// either host's positions would still be caught, just not by one shared
// assertion.
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVueHtmlBridgeCli } from "./cli.js";
import type { CliNdjsonRecord } from "./output/ndjson.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vhb-cli-e2e-"));
  tempDirs.push(dir);
  return dir;
}

function io(overrides: { argv: readonly string[]; cwd: string }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    run: () =>
      runVueHtmlBridgeCli({
        argv: overrides.argv,
        cwd: overrides.cwd,
        writeStdout: (chunk) => stdout.push(chunk),
        writeStderr: (chunk) => stderr.push(chunk),
        signal: new AbortController().signal,
        version: "0.0.0-test",
      }),
  };
}

const ARIA_CONTROLS_FIXTURE = fileURLToPath(
  new URL(
    "../../../examples/playground/logged-in-aria-controls.vue",
    import.meta.url,
  ),
);

const CUSTOM_DIRECTIVE_IMG_SRC_FIXTURE = fileURLToPath(
  new URL(
    "../../../examples/playground/custom-directive-img-src.vue",
    import.meta.url,
  ),
);

describe("CLI e2e: NDJSON goldens (cli.md §9 item 7)", () => {
  it("clean-plus-violation run: meta, file x N (sorted), summary — every line independently JSON.parse-able", async () => {
    const root = await tempWorkspace();
    const fixtureSource = await readFile(ARIA_CONTROLS_FIXTURE, "utf8");
    await writeFile(join(root, "Menu.vue"), fixtureSource);
    await writeFile(
      join(root, "Clean.vue"),
      "<template><div>hi</div></template>",
    );

    const { stdout, stderr, run } = io({
      argv: ["--format", "ndjson"],
      cwd: root,
    });
    const result = await run();

    expect(result).toEqual({ interrupted: false, exitCode: 1 });
    expect(stderr).toEqual([]);
    const lines = stdout
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
    const records = lines.map((line) => JSON.parse(line) as CliNdjsonRecord);

    expect(records[0]).toEqual({ type: "meta", version: 1 });
    expect(records.at(-1)).toMatchObject({
      type: "summary",
      filesAnalyzed: 2,
      errors: 1,
      runErrors: 0,
    });
    const fileRecords = records.filter(
      (r): r is Extract<CliNdjsonRecord, { type: "file" }> => r.type === "file",
    );
    expect(fileRecords.map((r) => r.path)).toEqual(["Clean.vue", "Menu.vue"]);
    expect(fileRecords[0]!.diagnostics).toEqual([]);
    expect(fileRecords[1]!.diagnostics).toHaveLength(1);
    const diagnostic = fileRecords[1]!.diagnostics[0]!;
    expect(diagnostic.code).toBe("no-refer-to-non-existent-id");
    expect(diagnostic.adapterId).toBe("markuplint");

    // No generated HTML or source text embedded anywhere in the stream.
    expect(stdout.join("")).not.toContain("<template>");
    expect(stdout.join("")).not.toContain(fixtureSource);
  });

  it("exit-2 run: a session-level adapter failure appears as a runError line, interleaved with file lines, summary still closes the stream", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "<template><div>a</div></template>");
    await writeFile(join(root, "B.vue"), "<template><div>b</div></template>");
    await writeFile(
      join(root, ".vue-html-bridge.json"),
      JSON.stringify({
        validators: [
          {
            adapter: "markuplint",
            enabled: true,
            settings: { configFile: "does-not-exist.json" },
          },
        ],
      }),
    );

    const { stdout, run } = io({ argv: ["--format", "ndjson"], cwd: root });
    const result = await run();
    expect(result).toEqual({ interrupted: false, exitCode: 2 });

    const lines = stdout
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
    const records = lines.map((line) => JSON.parse(line) as CliNdjsonRecord);
    expect(records[0]).toEqual({ type: "meta", version: 1 });
    expect(records.at(-1)!.type).toBe("summary");

    const runErrorRecords = records.filter(
      (r): r is Extract<CliNdjsonRecord, { type: "runError" }> =>
        r.type === "runError",
    );
    // Reported exactly once, not once per analyzed file.
    expect(runErrorRecords).toHaveLength(1);
    expect(runErrorRecords[0]!.code).toBe(
      "adapter/markuplint/configuration-error",
    );

    const fileRecords = records.filter(
      (r): r is Extract<CliNdjsonRecord, { type: "file" }> => r.type === "file",
    );
    expect(fileRecords.map((r) => r.path)).toEqual(["A.vue", "B.vue"]);
    // The session-failure code must not leak into any file's own diagnostics.
    for (const file of fileRecords) {
      expect(
        file.diagnostics.some((d) => d.code.startsWith("adapter/markuplint/")),
      ).toBe(false);
    }
    const summary = records.at(-1) as Extract<
      CliNdjsonRecord,
      { type: "summary" }
    >;
    expect(summary.runErrors).toBe(1);
  });
});

describe("CLI e2e: text output (cli.md §9 item 6, real fixture)", () => {
  it("reports the real Markuplint violation with a correct path:line:col and adapter tag", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, "Menu.vue"),
      await readFile(ARIA_CONTROLS_FIXTURE, "utf8"),
    );

    const { stdout, stderr, run } = io({ argv: [], cwd: root });
    const result = await run();
    expect(result).toEqual({ interrupted: false, exitCode: 1 });
    expect(stderr).toEqual([]);
    const text = stdout.join("");
    expect(text).toContain("Menu.vue:6:27 error no-refer-to-non-existent-id");
    expect(text).toContain("[markuplint]");
    expect(text).toContain(
      "1 file analyzed: 1 error, 0 warnings, 0 infos, 0 hints",
    );
  });
});

// plan.md "Custom-directive attribute value modeling ('Plan B')" / ADR-0010:
// end-to-end proof that settings-file -> CLI -> analyzer -> core wiring
// resolves a declared customDirectives mapping and makes the resulting
// required-attr false positive disappear.
describe("CLI e2e: customDirectives settings (plan.md, ADR-0010)", () => {
  it("a declared customDirectives mapping resolves v-src's value, making the required-attr false positive disappear", async () => {
    const root = await tempWorkspace();
    const fixtureSource = await readFile(
      CUSTOM_DIRECTIVE_IMG_SRC_FIXTURE,
      "utf8",
    );
    await writeFile(join(root, "Icon.vue"), fixtureSource);

    const baseline = io({ argv: [], cwd: root });
    const baselineResult = await baseline.run();
    expect(baselineResult).toEqual({ interrupted: false, exitCode: 1 });
    const baselineText = baseline.stdout.join("");
    expect(baselineText).toContain("required-attr");
    expect(baselineText).toContain("custom-directive-not-modeled");

    await writeFile(
      join(root, ".vue-html-bridge.json"),
      JSON.stringify({
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      }),
    );

    const configured = io({ argv: [], cwd: root });
    const configuredResult = await configured.run();
    expect(configuredResult).toEqual({ interrupted: false, exitCode: 0 });
    const configuredText = configured.stdout.join("");
    expect(configuredText).not.toContain("required-attr");
    expect(configuredText).not.toContain("custom-directive-not-modeled");
    expect(configuredText).not.toContain("custom-directive-value-unresolved");
  });
});

describe("CLI e2e: --untrusted (cli.md §5, §9 item 12)", () => {
  const DUPLICATE_ID_TEMPLATE =
    '<template><div id="x"></div><div id="x"></div></template>';

  it("an untrusted run ignores discovered workspace validator config", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".markuplintrc"),
      JSON.stringify({ rules: { "id-duplication": false } }),
    );
    await writeFile(join(root, "Dup.vue"), DUPLICATE_ID_TEMPLATE);

    const { stdout, run } = io({ argv: ["--untrusted"], cwd: root });
    const result = await run();
    expect(result.interrupted).toBe(false);
    expect(stdout.join("")).toContain("id-duplication");
  });

  it("a trusted run (the default) honors discovered workspace validator config", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".markuplintrc"),
      JSON.stringify({ rules: { "id-duplication": false } }),
    );
    await writeFile(join(root, "Dup.vue"), DUPLICATE_ID_TEMPLATE);

    const { stdout, run } = io({ argv: [], cwd: root });
    await run();
    expect(stdout.join("")).not.toContain("id-duplication");
  });

  it("host-neutral settings (exclude) still apply while untrusted", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "Dup.vue"), DUPLICATE_ID_TEMPLATE);
    await writeFile(join(root, "Skip.vue"), DUPLICATE_ID_TEMPLATE);

    const { stdout, run } = io({
      argv: ["--untrusted", "--exclude", "**/Skip.vue"],
      cwd: root,
    });
    await run();
    expect(stdout.join("")).toContain("Dup.vue");
    expect(stdout.join("")).not.toContain("Skip.vue");
  });

  it("--untrusted forces externalAdapters to disabled even over a config file's trusted-workspace-only, so a configured external adapter fails its gate (reported once, exit 2) instead of silently loading", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".vue-html-bridge.json"),
      JSON.stringify({
        externalAdapters: "trusted-workspace-only",
        validators: [
          { adapter: "markuplint", enabled: true },
          { adapter: "some-external-adapter-package", enabled: true },
        ],
      }),
    );
    await writeFile(
      join(root, "Clean.vue"),
      "<template><div>hi</div></template>",
    );

    const { stdout, stderr, run } = io({ argv: ["--untrusted"], cwd: root });
    const result = await run();
    // Failing the gate (not resolving/importing it at all) is a run-level
    // error like any other adapter-load failure (cli.md §8) — this is not
    // special-cased away just because `--untrusted` is what caused it.
    expect(result).toEqual({ interrupted: false, exitCode: 2 });
    const combined = stdout.join("") + stderr.join("");
    expect(combined).toContain("some-external-adapter-package");
    expect(combined).toContain("external-adapters-disabled");
  });
});
