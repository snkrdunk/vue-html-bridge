// File enumeration (cli.md §6 step 2): positional args replace `include`;
// directories expand to `<dir>/**/*.vue`; `exclude` always applies; globs
// follow "standard" semantics (`*` does not match dotfiles, unlike the
// `{ dot: true }` matching language-server's own didOpen-time
// include/exclude check uses for a different purpose — cli.md §7 states this
// explicitly for the CLI); symlinked/duplicate arguments dedupe to one
// analysis by real path; a resolved file outside the workspace root is a
// run-level error, isolated to that one argument; the final list is sorted
// by workspace-relative path.
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { RunLevelError } from "./types.js";

export interface EnumerateFilesOptions {
  /** Absolute. */
  workspaceRoot: string;
  /** Absolute; positional arguments are resolved relative to this (cli.md §2). */
  cwd: string;
  positionalArgs: readonly string[];
  include: readonly string[];
  exclude: readonly string[];
}

export interface EnumerateFilesResult {
  /** Absolute real paths, sorted by workspace-relative "/"-separated path. */
  files: readonly string[];
  /** Boundary violations (cli.md §6): one per out-of-root positional argument. */
  errors: readonly RunLevelError[];
}

const CASE_INSENSITIVE_PLATFORM =
  process.platform === "darwin" || process.platform === "win32";
const GLOB_META = /[*?[\]{}]/;

function toPosixRelative(base: string, target: string): string {
  return relative(base, target).split(sep).join("/");
}

function posixJoin(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * A targeted (not general-purpose) directory-pruning optimization: an
 * exclude pattern shaped exactly like the default `**\/node_modules/**`
 * (a plain literal name wrapped in `**\/…/**`) lets the walk skip descending
 * into any directory with that basename outright, instead of walking
 * potentially huge trees (node_modules) just to filter every file back out
 * afterward. Final correctness never depends on this — every candidate path
 * is still matched against the full pattern set below regardless.
 */
function buildDirectoryPrune(
  excludePatterns: readonly string[],
): (relDirPosix: string) => boolean {
  const prunableNames = new Set<string>();
  for (const pattern of excludePatterns) {
    const match = /^\*\*\/([^*?[\]{}!/]+)\/\*\*$/.exec(pattern);
    if (match) prunableNames.add(match[1]!);
  }
  if (prunableNames.size === 0) return () => false;
  return (relDirPosix) => {
    const base = relDirPosix.split("/").pop() ?? relDirPosix;
    return prunableNames.has(base);
  };
}

interface WalkedFile {
  abs: string;
  rel: string;
}

async function walk(
  root: string,
  prune: (relDirPosix: string) => boolean,
): Promise<WalkedFile[]> {
  const results: WalkedFile[] = [];

  async function recurse(dirAbs: string, relDirPosix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip silently
    }
    for (const entry of entries) {
      const entryRelPosix =
        relDirPosix === "" ? entry.name : `${relDirPosix}/${entry.name}`;
      const entryAbs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (prune(entryRelPosix)) continue;
        await recurse(entryAbs, entryRelPosix);
      } else if (entry.isFile()) {
        results.push({ abs: entryAbs, rel: entryRelPosix });
      } else if (entry.isSymbolicLink()) {
        // Symlinked directories are intentionally not traversed (avoids
        // cycle-detection complexity); symlinked files are included, and
        // resolved to their real path later during dedup.
        try {
          const target = await stat(entryAbs);
          if (target.isFile())
            results.push({ abs: entryAbs, rel: entryRelPosix });
        } catch {
          // Broken symlink: skip.
        }
      }
    }
  }

  await recurse(root, "");
  return results;
}

function matchesAny(relPosix: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(relPosix, pattern, { dot: false }),
  );
}

/** The longest literal (non-glob-metacharacter) path prefix of an absolute path or pattern. */
function staticBaseDir(absPath: string): string {
  const root = parse(absPath).root;
  const rest = absPath.slice(root.length);
  const segments = rest.split(sep).filter((segment) => segment.length > 0);
  const baseSegments: string[] = [];
  for (const segment of segments) {
    if (GLOB_META.test(segment)) break;
    baseSegments.push(segment);
  }
  return baseSegments.length === 0 ? root : join(root, ...baseSegments);
}

function isWithinRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

export async function enumerateFiles(
  options: EnumerateFilesOptions,
): Promise<EnumerateFilesResult> {
  const { workspaceRoot, cwd, positionalArgs, include, exclude } = options;
  const prune = buildDirectoryPrune(exclude);
  const walked = await walk(workspaceRoot, prune);

  const errors: RunLevelError[] = [];
  const matched = new Set<string>();

  if (positionalArgs.length > 0) {
    for (const arg of positionalArgs) {
      // path.resolve() is a pure string operation; it never touches the
      // filesystem, so glob metacharacters (`*`, `**`) survive untouched as
      // literal path segments — safe to use even on a pattern, not just a
      // concrete path.
      const absArgPath = resolve(cwd, arg);
      const base = staticBaseDir(absArgPath);
      if (!isWithinRoot(base, workspaceRoot)) {
        errors.push({
          code: "path-outside-workspace",
          message: `Argument "${arg}" resolves outside the workspace root "${workspaceRoot}".`,
        });
        continue;
      }
      const stats = await safeStat(absArgPath);
      const effectivePattern =
        stats?.isDirectory() === true
          ? posixJoin(toPosixRelative(workspaceRoot, absArgPath), "**/*.vue")
          : toPosixRelative(workspaceRoot, absArgPath);
      for (const entry of walked) {
        if (minimatch(entry.rel, effectivePattern, { dot: false })) {
          matched.add(entry.abs);
        }
      }
    }
  } else {
    for (const entry of walked) {
      if (matchesAny(entry.rel, include)) matched.add(entry.abs);
    }
  }

  const relByAbs = new Map(walked.map((entry) => [entry.abs, entry.rel]));
  const survivors = [...matched].filter((abs) => {
    const rel = relByAbs.get(abs) ?? toPosixRelative(workspaceRoot, abs);
    return !matchesAny(rel, exclude);
  });

  // Identity and dedup: normalize to the real path, case-folded on a
  // case-insensitive platform (cli.md §6). Two arguments reaching the same
  // real path analyze it once.
  const deduped = new Map<string, string>();
  for (const abs of survivors) {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      real = abs;
    }
    const key = CASE_INSENSITIVE_PLATFORM ? real.toLowerCase() : real;
    if (!deduped.has(key)) deduped.set(key, real);
  }

  const files = [...deduped.values()].sort((a, b) => {
    const relA = toPosixRelative(workspaceRoot, a);
    const relB = toPosixRelative(workspaceRoot, b);
    return relA < relB ? -1 : relA > relB ? 1 : 0;
  });

  return { files, errors };
}
