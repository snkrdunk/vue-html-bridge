// `--emit-html <dir>` (plan.md T4, ADR-0011): path composition reusing the
// existing virtual-filename convention (analyzer.md §5.2), the Q1 sidecar
// shape, the Q4 pre-run directory lifecycle, and the Q2 stderr notice. Kept
// as its own small module per cli.md §11's one-module-per-concern
// convention (line-index.ts, exit-codes.ts, output/*.ts).
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { VariantArtifact } from "@vue-html-bridge/analyzer";

const VIRTUAL_SUFFIX_PATTERN =
  /\.__vue_html_bridge__\/variant-[0-9a-f]+\.html$/;
const TOOL_OWNED_DIR_SUFFIX = ".__vue_html_bridge__";

/** Same convention as runner.ts's own helper (cli.md §7: workspace-relative, "/"-separated on every platform). */
function toWorkspaceRelativePosix(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

export interface EmitHtmlPaths {
  htmlPath: string;
  sidecarPath: string;
  /** Workspace-relative form of the source file this artifact was generated from. */
  sourceFilenameRelative: string;
}

/**
 * Composes on-disk paths for one `VariantArtifact`: `<dir>` joined with the
 * workspace-relative form of its `virtualFilename` (analyzer.md §5.2) —
 * `<dir>/<workspace-relative-source>.__vue_html_bridge__/variant-<hash>.html`
 * — plus a paired `.json` sidecar (Q1). The path does not need to exist on
 * the filesystem beforehand (same contract as `virtualFilename` itself).
 */
export function emitHtmlPaths(
  workspaceRoot: string,
  dir: string,
  artifact: VariantArtifact,
): EmitHtmlPaths {
  const relativeVirtualPath = toWorkspaceRelativePosix(
    workspaceRoot,
    artifact.virtualFilename,
  );
  const sourceFilenameRelative = relativeVirtualPath.replace(
    VIRTUAL_SUFFIX_PATTERN,
    "",
  );
  const htmlPath = join(dir, relativeVirtualPath);
  const sidecarPath = htmlPath.replace(/\.html$/, ".json");
  return { htmlPath, sidecarPath, sourceFilenameRelative };
}

export interface EmitHtmlSidecar {
  htmlFile: string;
  sourceFilename: string;
  variants: VariantArtifact["variants"];
  map: VariantArtifact["map"];
}

/** Q1 sidecar shape (plan.md): one JSON file per emitted HTML file, sharing its basename. */
export function buildSidecar(
  artifact: VariantArtifact,
  sourceFilenameRelative: string,
): EmitHtmlSidecar {
  return {
    htmlFile: `variant-${artifact.htmlHash}.html`,
    sourceFilename: sourceFilenameRelative,
    variants: artifact.variants,
    map: artifact.map,
  };
}

export interface WriteVariantArtifactsOptions {
  dir: string;
  workspaceRoot: string;
  artifacts: readonly VariantArtifact[];
}

/** Writes each artifact's paired HTML + sidecar JSON file. Returns the count of HTML files written. */
export async function writeVariantArtifacts(
  options: WriteVariantArtifactsOptions,
): Promise<number> {
  let written = 0;
  for (const artifact of options.artifacts) {
    const { htmlPath, sidecarPath, sourceFilenameRelative } = emitHtmlPaths(
      options.workspaceRoot,
      options.dir,
      artifact,
    );
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, artifact.html, "utf8");
    const sidecar = buildSidecar(artifact, sourceFilenameRelative);
    await writeFile(
      sidecarPath,
      `${JSON.stringify(sidecar, null, 2)}\n`,
      "utf8",
    );
    written += 1;
  }
  return written;
}

/**
 * Q4 pre-run lifecycle: create `<dir>` if missing; otherwise recursively
 * remove only subdirectories whose name ends with `.__vue_html_bridge__`
 * (the tool's own naming convention, analyzer.md §5.2) — never anything
 * else under `<dir>`. This is the highest-risk piece of the whole feature
 * (plan.md Risks #1): written defensively — it only ever removes a
 * directory matching this exact suffix, and only recurses into (never
 * removes) any other directory, so unrelated sibling content always
 * survives a run.
 */
export async function prepareEmitHtmlDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await cleanToolOwnedSubdirs(dir);
}

async function cleanToolOwnedSubdirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(dir, entry.name);
    if (entry.name.endsWith(TOOL_OWNED_DIR_SUFFIX)) {
      await rm(entryPath, { recursive: true, force: true });
    } else {
      await cleanToolOwnedSubdirs(entryPath);
    }
  }
}

/**
 * Q2: one stderr notice per run (not an NDJSON record — cli.md §7.2's
 * "never contains generated HTML or source text" constraint is left
 * untouched by this feature), mirroring the existing `--untrusted`
 * stderr-notice precedent (cli.md §5).
 */
export function formatEmitHtmlNotice(dir: string, fileCount: number): string {
  const noun = fileCount === 1 ? "file" : "files";
  return `--emit-html: wrote ${fileCount} variant ${noun} under "${dir}".\n`;
}
