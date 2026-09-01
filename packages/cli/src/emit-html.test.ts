// plan.md T4: path composition, Q1 sidecar shape, Q4 directory lifecycle
// (the highest-risk piece of the whole feature — unrelated content under
// `<dir>` must always survive a run), and the Q2 stderr notice.
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VariantArtifact } from "@vue-html-bridge/analyzer";
import {
  buildSidecar,
  emitHtmlPaths,
  formatEmitHtmlNotice,
  prepareEmitHtmlDir,
  writeVariantArtifacts,
} from "./emit-html.js";

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "emit-html-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function fakeArtifact(
  sourceAbsolute: string,
  hash: string,
  overrides: Partial<VariantArtifact> = {},
): VariantArtifact {
  return {
    htmlHash: hash,
    virtualFilename: `${sourceAbsolute}.__vue_html_bridge__/variant-${hash}.html`,
    html: "<p>x</p>",
    variants: [{ variantId: "v1", decisions: [] }],
    map: [],
    ...overrides,
  };
}

describe("emitHtmlPaths (plan.md T4/Q1)", () => {
  it("composes <dir> + workspace-relative virtual-filename path, plus a paired .json sidecar path", () => {
    const artifact = fakeArtifact(
      "/workspace/src/components/Foo.vue",
      "abc123",
    );
    const { htmlPath, sidecarPath, sourceFilenameRelative } = emitHtmlPaths(
      "/workspace",
      "/out",
      artifact,
    );
    expect(htmlPath).toBe(
      join(
        "/out",
        "src",
        "components",
        "Foo.vue.__vue_html_bridge__",
        "variant-abc123.html",
      ),
    );
    expect(sidecarPath).toBe(
      join(
        "/out",
        "src",
        "components",
        "Foo.vue.__vue_html_bridge__",
        "variant-abc123.json",
      ),
    );
    expect(sourceFilenameRelative).toBe("src/components/Foo.vue");
  });
});

describe("buildSidecar (plan.md T4/Q1)", () => {
  it("carries every member variant's decisions and the representative's map, keyed to the html file's own basename", () => {
    const artifact = fakeArtifact("/workspace/A.vue", "hash1", {
      variants: [
        {
          variantId: "v1",
          decisions: [{ decisionId: "d1", displayName: "a", value: true }],
        },
        {
          variantId: "v2",
          decisions: [{ decisionId: "d1", displayName: "a", value: false }],
        },
      ],
      map: [
        {
          generated: { start: 0, end: 3 },
          source: { filename: "/workspace/A.vue", start: 10, end: 13 },
          kind: "attribute-value",
          provenance: {
            kind: "source-literal",
            sourceRange: { filename: "/workspace/A.vue", start: 10, end: 13 },
          },
        },
      ],
    });
    const sidecar = buildSidecar(artifact, "A.vue");
    expect(sidecar.htmlFile).toBe("variant-hash1.html");
    expect(sidecar.sourceFilename).toBe("A.vue");
    expect(sidecar.variants).toHaveLength(2);
    expect(sidecar.map).toHaveLength(1);
  });
});

describe("writeVariantArtifacts (plan.md T4)", () => {
  it("writes the paired HTML + sidecar JSON file for each artifact, creating parent directories", async () => {
    const dir = await makeTempDir();
    const workspaceRoot = await makeTempDir();
    const artifact = fakeArtifact(join(workspaceRoot, "Menu.vue"), "abc123");
    const count = await writeVariantArtifacts({
      dir,
      workspaceRoot,
      artifacts: [artifact],
    });
    expect(count).toBe(1);
    const { htmlPath, sidecarPath } = emitHtmlPaths(
      workspaceRoot,
      dir,
      artifact,
    );
    expect(await readFile(htmlPath, "utf8")).toBe("<p>x</p>");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(sidecar.htmlFile).toBe("variant-abc123.html");
  });
});

describe("prepareEmitHtmlDir (plan.md T4/Q4 — highest-risk piece of the feature)", () => {
  it("creates <dir> when missing", async () => {
    const parent = await makeTempDir();
    const dir = join(parent, "does-not-exist-yet");
    await prepareEmitHtmlDir(dir);
    expect((await readdir(dir)).length).toBe(0);
  });

  it("removes only pre-existing *.__vue_html_bridge__ subdirectories, at any depth, before writing", async () => {
    const dir = await makeTempDir();
    const staleDir = join(dir, "src", "Old.vue.__vue_html_bridge__");
    await mkdir(staleDir, { recursive: true });
    await writeFile(
      join(staleDir, "variant-stale.html"),
      "<p>stale</p>",
      "utf8",
    );

    await prepareEmitHtmlDir(dir);

    await expect(readdir(staleDir)).rejects.toThrow();
  });

  it("never removes unrelated files or directories under <dir> (the critical safety property)", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "README.md"), "unrelated content", "utf8");
    await mkdir(join(dir, "unrelated-dir"), { recursive: true });
    await writeFile(
      join(dir, "unrelated-dir", "keep-me.txt"),
      "unrelated nested content",
      "utf8",
    );
    const staleDir = join(dir, "src", "Old.vue.__vue_html_bridge__");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "variant-stale.html"), "stale", "utf8");

    await prepareEmitHtmlDir(dir);

    expect(await readFile(join(dir, "README.md"), "utf8")).toBe(
      "unrelated content",
    );
    expect(
      await readFile(join(dir, "unrelated-dir", "keep-me.txt"), "utf8"),
    ).toBe("unrelated nested content");
    await expect(readdir(staleDir)).rejects.toThrow();
    // "src" itself (an ordinary ancestor directory, not tool-owned) must survive.
    expect(await readdir(join(dir, "src"))).toEqual([]);
  });
});

describe("formatEmitHtmlNotice (plan.md T4/Q2)", () => {
  it("pluralizes correctly and names the directory", () => {
    expect(formatEmitHtmlNotice("/out", 1)).toBe(
      '--emit-html: wrote 1 variant file under "/out".\n',
    );
    expect(formatEmitHtmlNotice("/out", 3)).toBe(
      '--emit-html: wrote 3 variant files under "/out".\n',
    );
  });
});
