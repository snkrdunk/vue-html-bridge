/**
 * Default `AdapterModuleResolver` (adapter-loader.md §3, §4 item 2 bullet
 * 5): plain Node.js module resolution rooted at `workspaceRoot`, followed
 * by a dynamic `import()`. No Yarn PnP support in v1 (ADR-0008) — this is
 * the seam a PnP-aware resolver would replace.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterModuleResolver } from "./types.js";

/**
 * Thrown by `nodeModuleResolver` when the specifier cannot be found from
 * `workspaceRoot`. `load.ts` uses this to distinguish a resolution failure
 * ("resolution-failed") from the imported module itself throwing while
 * evaluating ("import-threw") — any rejection that is not this error is
 * treated as the latter.
 */
export class AdapterModuleResolutionError extends Error {
  override readonly name = "AdapterModuleResolutionError" as const;
}

export const nodeModuleResolver: AdapterModuleResolver = async (
  specifier,
  workspaceRoot,
) => {
  const resolvedPath = resolveSpecifierPath(specifier, workspaceRoot);
  return import(pathToFileURL(resolvedPath).href);
};

function resolveSpecifierPath(
  specifier: string,
  workspaceRoot: string,
): string {
  // `createRequire`'s argument only sets the base directory module
  // resolution walks up from — it need not exist on disk.
  const require = createRequire(join(workspaceRoot, "package.json"));
  try {
    return require.resolve(specifier);
  } catch (requireError) {
    // `require.resolve` uses the CJS resolution algorithm: for a package
    // with an "exports" map, it only ever considers "require"/"node"/
    // "default" conditions. A pure-ESM package that exports only an
    // "import" condition (every package.json in this monorepo does, and
    // that is an increasingly common shape for real npm packages) is
    // therefore unresolvable that way even though `import()` — what we
    // actually do with the result — handles it fine. Fall back to reading
    // the package's own package.json and picking an entry point ourselves,
    // preferring "import".
    const packageDir = findPackageDirectory(require, specifier);
    const entryFile = packageDir && resolveEntryFile(packageDir);
    if (entryFile) return entryFile;
    throw new AdapterModuleResolutionError(
      `Could not resolve "${specifier}" from workspace "${workspaceRoot}": ${errorMessage(requireError)}`,
      { cause: requireError },
    );
  }
}

function findPackageDirectory(
  require: NodeJS.Require,
  specifier: string,
): string | undefined {
  const searchPaths = require.resolve.paths(specifier) ?? [];
  for (const dir of searchPaths) {
    const candidate = join(dir, specifier);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

function resolveEntryFile(packageDir: string): string | undefined {
  const manifestPath = join(packageDir, "package.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }

  const fromExports = entryFromExportsField(manifest.exports, packageDir);
  if (fromExports) return fromExports;
  if (typeof manifest.module === "string") {
    return join(packageDir, manifest.module);
  }
  if (typeof manifest.main === "string") {
    return join(packageDir, manifest.main);
  }
  const indexCandidate = join(packageDir, "index.js");
  return existsSync(indexCandidate) ? indexCandidate : undefined;
}

/** Handles the common shapes of a package's root (".") `exports` field —
 * not the full exports-map spec (no subpath patterns, no array fallbacks,
 * no per-condition subpaths beyond the root). */
function entryFromExportsField(
  exportsField: unknown,
  packageDir: string,
): string | undefined {
  if (typeof exportsField === "string") return join(packageDir, exportsField);
  if (
    typeof exportsField !== "object" ||
    exportsField === null ||
    Array.isArray(exportsField)
  ) {
    return undefined;
  }
  const record = exportsField as Record<string, unknown>;
  const rootExport = "." in record ? record["."] : record;
  return entryFromConditions(rootExport, packageDir);
}

function entryFromConditions(
  value: unknown,
  packageDir: string,
): string | undefined {
  if (typeof value === "string") return join(packageDir, value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const condition of ["import", "default", "node"]) {
    if (condition in record) {
      const resolved = entryFromConditions(record[condition], packageDir);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
