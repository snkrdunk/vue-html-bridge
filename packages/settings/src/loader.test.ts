import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeFileSystem,
  loadSettingsFile,
  loadWorkspaceSettingsFile,
  type SettingsFileSystem,
} from "./loader.js";

/** In-memory fake for tests that don't need real disk behavior. */
function createFakeFileSystem(
  files: Readonly<Record<string, string>>,
  unreadable: ReadonlySet<string> = new Set(),
): SettingsFileSystem {
  return {
    async readFile(absolutePath) {
      if (unreadable.has(absolutePath)) {
        throw new Error("EACCES: permission denied");
      }
      return Object.hasOwn(files, absolutePath)
        ? files[absolutePath]
        : undefined;
    },
  };
}

describe("loadWorkspaceSettingsFile: discovery (§8 item 5)", () => {
  it("prefers .vue-html-bridge.json over package.json's vueHtmlBridge field", async () => {
    const fs = createFakeFileSystem({
      "/ws/.vue-html-bridge.json": JSON.stringify({ debounceMs: 1 }),
      "/ws/package.json": JSON.stringify({
        vueHtmlBridge: { debounceMs: 2 },
      }),
    });
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result).toEqual({
      settings: { debounceMs: 1 },
      issues: [],
      sourcePath: "/ws/.vue-html-bridge.json",
    });
  });

  it("falls back to package.json's vueHtmlBridge field when the dedicated file is absent", async () => {
    const fs = createFakeFileSystem({
      "/ws/package.json": JSON.stringify({
        name: "some-project",
        vueHtmlBridge: { enabled: false },
      }),
    });
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result).toEqual({
      settings: { enabled: false },
      issues: [],
      sourcePath: "/ws/package.json",
    });
  });

  it("is not an issue when neither file exists: defaults apply", async () => {
    const fs = createFakeFileSystem({});
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result).toEqual({ settings: {}, issues: [] });
  });

  it("is not an issue when package.json exists but has no vueHtmlBridge field", async () => {
    const fs = createFakeFileSystem({
      "/ws/package.json": JSON.stringify({ name: "some-project" }),
    });
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result).toEqual({ settings: {}, issues: [] });
  });

  it("a parse error in the dedicated file is an issue with sourcePath, and does not fall through to package.json", async () => {
    const fs = createFakeFileSystem({
      "/ws/.vue-html-bridge.json": "{ not valid json",
      "/ws/package.json": JSON.stringify({
        vueHtmlBridge: { debounceMs: 999 },
      }),
    });
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result.settings).toEqual({});
    expect(result.sourcePath).toBe("/ws/.vue-html-bridge.json");
    expect(result.issues).toMatchObject([
      {
        severity: "error",
        code: "parse-error",
        sourcePath: "/ws/.vue-html-bridge.json",
      },
    ]);
  });

  it("an unreadable dedicated file is a file-unreadable issue, and does not fall through to package.json", async () => {
    const fs = createFakeFileSystem(
      {
        "/ws/package.json": JSON.stringify({
          vueHtmlBridge: { debounceMs: 999 },
        }),
      },
      new Set(["/ws/.vue-html-bridge.json"]),
    );
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result.settings).toEqual({});
    expect(result.sourcePath).toBe("/ws/.vue-html-bridge.json");
    expect(result.issues).toMatchObject([
      {
        severity: "error",
        code: "file-unreadable",
        sourcePath: "/ws/.vue-html-bridge.json",
      },
    ]);
  });

  it("a parse error in package.json itself is a parse-error issue", async () => {
    const fs = createFakeFileSystem({
      "/ws/package.json": "not json at all",
    });
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result.settings).toEqual({});
    expect(result.sourcePath).toBe("/ws/package.json");
    expect(result.issues).toMatchObject([{ code: "parse-error" }]);
  });

  it("a non-object vueHtmlBridge field in package.json is a parse-error issue", async () => {
    const fs = createFakeFileSystem({
      "/ws/package.json": JSON.stringify({ vueHtmlBridge: "not an object" }),
    });
    const result = await loadWorkspaceSettingsFile("/ws", fs);
    expect(result.settings).toEqual({});
    expect(result.sourcePath).toBe("/ws/package.json");
    expect(result.issues).toMatchObject([{ code: "parse-error" }]);
  });
});

describe("loadSettingsFile: explicit file (§8 item 6)", () => {
  it("loads a settings object from an arbitrary path", async () => {
    const fs = createFakeFileSystem({
      "/anywhere/custom.json": JSON.stringify({ debounceMs: 7 }),
    });
    const result = await loadSettingsFile("/anywhere/custom.json", fs);
    expect(result).toEqual({
      settings: { debounceMs: 7 },
      issues: [],
      sourcePath: "/anywhere/custom.json",
    });
  });

  it("does not special-case package.json: the file's own content is the settings object, verbatim", async () => {
    const rawPackageJson = {
      name: "some-project",
      vueHtmlBridge: { debounceMs: 7 },
    };
    const fs = createFakeFileSystem({
      "/ws/package.json": JSON.stringify(rawPackageJson),
    });
    const result = await loadSettingsFile("/ws/package.json", fs);
    // The whole document is treated as the settings object; there is no
    // `vueHtmlBridge` extraction here (that only happens in discovery).
    expect(result.settings).toEqual(rawPackageJson);
  });

  it("a missing file is file-missing, with an absolute sourcePath", async () => {
    const fs = createFakeFileSystem({});
    const result = await loadSettingsFile("/anywhere/missing.json", fs);
    expect(result).toEqual({
      settings: {},
      issues: [
        {
          severity: "error",
          code: "file-missing",
          path: "",
          message: 'Settings file not found: "/anywhere/missing.json".',
          sourcePath: "/anywhere/missing.json",
        },
      ],
      sourcePath: "/anywhere/missing.json",
    });
  });

  it("an unreadable file is file-unreadable, with an absolute sourcePath", async () => {
    const fs = createFakeFileSystem({}, new Set(["/anywhere/protected.json"]));
    const result = await loadSettingsFile("/anywhere/protected.json", fs);
    expect(result.issues).toMatchObject([
      {
        severity: "error",
        code: "file-unreadable",
        sourcePath: "/anywhere/protected.json",
      },
    ]);
  });

  it("invalid JSON is a parse-error, with an absolute sourcePath", async () => {
    const fs = createFakeFileSystem({
      "/anywhere/broken.json": "{ oops",
    });
    const result = await loadSettingsFile("/anywhere/broken.json", fs);
    expect(result.issues).toMatchObject([
      {
        severity: "error",
        code: "parse-error",
        sourcePath: "/anywhere/broken.json",
      },
    ]);
  });

  it("rejects a relative path synchronously, as a caller precondition violation", async () => {
    const fs = createFakeFileSystem({});
    await expect(loadSettingsFile("relative/path.json", fs)).rejects.toThrow(
      /absolute path/,
    );
  });
});

describe("real filesystem integration (createNodeFileSystem)", () => {
  let workspaceRoot: string;

  afterEach(async () => {
    if (workspaceRoot)
      await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("reads a real .vue-html-bridge.json from disk", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "vhb-settings-"));
    await writeFile(
      join(workspaceRoot, ".vue-html-bridge.json"),
      JSON.stringify({ debounceMs: 321 }),
      "utf8",
    );
    const result = await loadWorkspaceSettingsFile(
      workspaceRoot,
      createNodeFileSystem(),
    );
    expect(result.settings).toEqual({ debounceMs: 321 });
    expect(result.sourcePath).toBe(
      join(workspaceRoot, ".vue-html-bridge.json"),
    );
    expect(result.issues).toEqual([]);
  });

  it("never walks upward past the given workspace root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vhb-settings-parent-"));
    workspaceRoot = join(parent, "nested-workspace");
    await mkdir(workspaceRoot);
    // A settings file in the *parent* directory must never be found.
    await writeFile(
      join(parent, ".vue-html-bridge.json"),
      JSON.stringify({ debounceMs: 999 }),
      "utf8",
    );
    const result = await loadWorkspaceSettingsFile(
      workspaceRoot,
      createNodeFileSystem(),
    );
    expect(result).toEqual({ settings: {}, issues: [] });
    await rm(parent, { recursive: true, force: true });
  });

  it("loads an explicit file from a real path with an absolute sourcePath", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "vhb-settings-"));
    const explicitPath = join(workspaceRoot, "bridge.config.json");
    await writeFile(explicitPath, JSON.stringify({ enabled: false }), "utf8");
    const result = await loadSettingsFile(explicitPath, createNodeFileSystem());
    expect(result).toEqual({
      settings: { enabled: false },
      issues: [],
      sourcePath: explicitPath,
    });
  });

  it("reports file-missing for a real, genuinely absent path", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "vhb-settings-"));
    const missingPath = join(workspaceRoot, "does-not-exist.json");
    const result = await loadSettingsFile(missingPath, createNodeFileSystem());
    expect(result.issues).toMatchObject([{ code: "file-missing" }]);
  });
});
