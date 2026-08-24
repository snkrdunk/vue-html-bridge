// cli.md §9 item 2: precedence (flags > --config > discovered file >
// defaults) and fatality (explicit --config missing/unreadable/unparsable
// exits 2 without fallback; error-level issues stop the run; warnings
// continue). Uses a real temp directory and real fs, matching the
// monorepo's "no mocking except deliberate failure injection" discipline.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliSettings } from "./settings-resolution.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vhb-cli-settings-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveCliSettings: precedence (cli.md §4.1, §9 item 2)", () => {
  it("flags win over a discovered workspace file, which wins over defaults", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeFile(
      join(workspaceRoot, ".vue-html-bridge.json"),
      JSON.stringify({ maxConcurrency: 2, warnVariantCount: 50 }),
    );

    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: { maxConcurrency: 5 },
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Flags win for maxConcurrency; the discovered file's warnVariantCount
    // (not overridden by any flag) still applies.
    expect(result.settings.maxConcurrency).toBe(5);
    expect(result.settings.warnVariantCount).toBe(50);
  });

  it("an explicit --config file wins over (and replaces, not merges with) a discovered workspace file", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeFile(
      join(workspaceRoot, ".vue-html-bridge.json"),
      JSON.stringify({ maxConcurrency: 2 }),
    );
    const explicitConfigPath = join(workspaceRoot, "explicit.json");
    await writeFile(explicitConfigPath, JSON.stringify({ maxConcurrency: 9 }));

    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      configPath: explicitConfigPath,
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.settings.maxConcurrency).toBe(9);
  });

  it("defaults apply when nothing else sets a field", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.settings.include).toEqual(["**/*.vue"]);
    expect(result.settings.externalAdapters).toBe("disabled");
  });

  it("--config resolves a relative path against the current working directory, not the workspace root", async () => {
    const workspaceRoot = await tempWorkspace();
    const otherCwd = await tempWorkspace();
    await writeFile(
      join(otherCwd, "rel.json"),
      JSON.stringify({ maxConcurrency: 7 }),
    );

    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: otherCwd,
      configPath: "rel.json",
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.settings.maxConcurrency).toBe(7);
  });
});

describe("resolveCliSettings: fatality (cli.md §4.1, §9 item 2)", () => {
  it("a missing explicit --config file is fatal (exit-2 shaped: kind 'fatal'), never falls back to defaults", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      configPath: join(workspaceRoot, "does-not-exist.json"),
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(result.issues.some((issue) => issue.code === "file-missing")).toBe(
      true,
    );
  });

  it("an unparsable explicit --config file is fatal", async () => {
    const workspaceRoot = await tempWorkspace();
    const configPath = join(workspaceRoot, "bad.json");
    await writeFile(configPath, "{ not json");
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      configPath,
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(result.issues.some((issue) => issue.code === "parse-error")).toBe(
      true,
    );
  });

  it("an unreadable explicit --config file (a directory given as the path) is fatal", async () => {
    const workspaceRoot = await tempWorkspace();
    const configPath = join(workspaceRoot, "a-directory.json");
    await mkdir(configPath);
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      configPath,
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "file-unreadable" || issue.code === "parse-error",
      ),
    ).toBe(true);
  });

  it("an error-level settings issue (invalid type) is fatal even from a flag", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      // NaN (from an unparsable --max-concurrency value) is still typeof
      // "number" but fails resolveSettings' own Number.isInteger check.
      flagsInput: { maxConcurrency: Number.NaN },
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") return;
    expect(result.issues.some((issue) => issue.code === "invalid-type")).toBe(
      true,
    );
  });

  it("a warning-level issue (unknown field) does not stop the run", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeFile(
      join(workspaceRoot, ".vue-html-bridge.json"),
      JSON.stringify({ notARealField: true }),
    );
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(
      result.warnings.some((issue) => issue.code === "unknown-field"),
    ).toBe(true);
  });

  it("no discovered file at all is not an issue (defaults apply silently)", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: {},
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.warnings).toEqual([]);
  });
});

describe("resolveCliSettings: --untrusted trust forcing (cli.md §5, §9 item 12)", () => {
  it("forces externalAdapters to disabled and workspaceTrusted to false, even over a config file's trusted-workspace-only", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeFile(
      join(workspaceRoot, ".vue-html-bridge.json"),
      JSON.stringify({ externalAdapters: "trusted-workspace-only" }),
    );
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: {},
      validatorOps: [],
      untrusted: true,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.settings.externalAdapters).toBe("disabled");
    expect(result.workspaceTrusted).toBe(false);
  });

  it("host-neutral settings (include/exclude/customElements/maxConcurrency) are unaffected by --untrusted", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: { include: ["only/**/*.vue"], maxConcurrency: 2 },
      validatorOps: [],
      untrusted: true,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.settings.include).toEqual(["only/**/*.vue"]);
    expect(result.settings.maxConcurrency).toBe(2);
  });

  it("without --untrusted, workspaceTrusted is true and externalAdapters keeps its resolved value", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: { externalAdapters: "trusted-workspace-only" },
      validatorOps: [],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.workspaceTrusted).toBe(true);
    expect(result.settings.externalAdapters).toBe("trusted-workspace-only");
  });
});

describe("resolveCliSettings: validator-flag patches apply after resolution (cli.md §4.3)", () => {
  it("patches the resolved validators[] rather than feeding another array-replacement layer", async () => {
    const workspaceRoot = await tempWorkspace();
    await writeFile(
      join(workspaceRoot, ".vue-html-bridge.json"),
      JSON.stringify({
        validators: [{ adapter: "markuplint", enabled: true }],
      }),
    );
    const result = await resolveCliSettings({
      workspaceRoot,
      cwd: workspaceRoot,
      flagsInput: {},
      validatorOps: [{ kind: "disable", entryKey: "markuplint" }],
      untrusted: false,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.settings.validators).toEqual([
      { adapter: "markuplint", enabled: false },
    ]);
  });
});
