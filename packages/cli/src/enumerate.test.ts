// cli.md §9 item 4: file enumeration, against a real temp directory and
// real fs (mirrors packages/adapter-markuplint/src/index.test.ts's
// mkdtemp/writeFile/rm pattern).
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enumerateFiles } from "./enumerate.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Returns the *real* path of a fresh temp directory (not the raw mkdtemp
 * result) — on macOS the OS temp directory is itself a symlink
 * (/var -> /private/var), and enumerateFiles' own dedup step resolves
 * discovered files to their real path (cli.md §6), so a test root must
 * already be canonical for its own relative-path math to line up with what
 * enumerateFiles returns (matching cli.ts's own top-level realpath()).
 */
async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vhb-cli-enumerate-"));
  tempDirs.push(dir);
  return realpath(dir);
}

const DEFAULT_INCLUDE = ["**/*.vue"];
const DEFAULT_EXCLUDE = ["**/node_modules/**"];

async function relFiles(
  workspaceRoot: string,
  files: readonly string[],
): Promise<string[]> {
  return files
    .map((abs) =>
      abs
        .slice(workspaceRoot.length + 1)
        .split("\\")
        .join("/"),
    )
    .sort();
}

describe("enumerateFiles (cli.md §6 step 2, §9 item 4)", () => {
  it("with no positional args, uses `include` relative to the workspace root, minus `exclude`", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src", "components"), { recursive: true });
    await writeFile(join(root, "src", "components", "A.vue"), "");
    await writeFile(join(root, "src", "components", "B.vue"), "");
    await writeFile(join(root, "README.md"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual([
      "src/components/A.vue",
      "src/components/B.vue",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("positional args replace `include` entirely", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "src", "A.vue"), "");
    await writeFile(join(root, "other", "B.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["other"],
      include: DEFAULT_INCLUDE, // would otherwise match both
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual(["other/B.vue"]);
  });

  it("a directory positional argument expands to <dir>/**/*.vue", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "widgets", "nested"), { recursive: true });
    await writeFile(join(root, "widgets", "Top.vue"), "");
    await writeFile(join(root, "widgets", "nested", "Deep.vue"), "");
    await writeFile(join(root, "widgets", "not-vue.txt"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["widgets"],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual([
      "widgets/Top.vue",
      "widgets/nested/Deep.vue",
    ]);
  });

  it("a literal file positional argument matches exactly that file", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.vue"), "");
    await writeFile(join(root, "B.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["A.vue"],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual(["A.vue"]);
  });

  it("a glob-pattern positional argument is matched against the workspace tree", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src", "a"), { recursive: true });
    await mkdir(join(root, "src", "b"), { recursive: true });
    await writeFile(join(root, "src", "a", "X.vue"), "");
    await writeFile(join(root, "src", "b", "Y.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["src/a/*.vue"],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual(["src/a/X.vue"]);
  });

  it("`exclude` always applies, even to a positional argument's matches", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "Keep.vue"), "");
    await writeFile(join(root, "src", "Gen.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["src"],
      include: DEFAULT_INCLUDE,
      exclude: [...DEFAULT_EXCLUDE, "**/Gen.vue"],
    });
    expect(await relFiles(root, result.files)).toEqual(["src/Keep.vue"]);
  });

  it("the default exclude skips node_modules", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "Vendored.vue"), "");
    await writeFile(join(root, "App.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual(["App.vue"]);
  });

  it("dotfile directories/files are not matched by `**/*.vue` (standard glob semantics: `*` does not match dotfiles)", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, ".hidden", "Ghost.vue"), "");
    await writeFile(join(root, ".DottedFile.vue"), "");
    await writeFile(join(root, "Visible.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual(["Visible.vue"]);
  });

  it("symlink and duplicate arguments dedupe to a single analysis", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "Real.vue"), "");
    await symlink(join(root, "Real.vue"), join(root, "Link.vue"));

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["Real.vue", "Link.vue", "Real.vue"],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(result.files).toHaveLength(1);
  });

  it("a path outside the workspace root is a run-level error, isolated to that argument", async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "Inside.vue"), "");
    await writeFile(join(outside, "Outside.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [join(outside, "Outside.vue"), "src/Inside.vue"],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(await relFiles(root, result.files)).toEqual(["src/Inside.vue"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("path-outside-workspace");
  });

  it("a relative-path escape (`../`) is also a boundary violation", async () => {
    const parent = await tempWorkspace();
    const root = join(parent, "workspace");
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, "other"), { recursive: true });
    await writeFile(join(parent, "other", "File.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: ["../other/File.vue"],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(result.files).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("path-outside-workspace");
  });

  it("ordering is deterministic (sorted by workspace-relative path)", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "z"), { recursive: true });
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "z", "Z.vue"), "");
    await writeFile(join(root, "a", "A.vue"), "");
    await writeFile(join(root, "M.vue"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    // relFiles() itself sorts, so assert against the raw (pre-sort) list too,
    // to prove enumerateFiles' own ordering is already correct.
    const rawRel = result.files.map((abs) => abs.slice(root.length + 1));
    expect(rawRel).toEqual(["M.vue", "a/A.vue", "z/Z.vue"]);
  });

  it("no matches produces an empty file list (the caller decides this is a fatal 'no analyzable input')", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "README.md"), "");

    const result = await enumerateFiles({
      workspaceRoot: root,
      cwd: root,
      positionalArgs: [],
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDE,
    });
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
