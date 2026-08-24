/**
 * Discovery and parsing of `.vue-html-bridge.json` / `package.json`'s
 * `vueHtmlBridge` field, and loading an explicit settings file given by
 * path (settings.md §5). The filesystem is injected for testability; the
 * loaders never throw for content problems — every failure kind becomes a
 * `SettingsIssue` with `sourcePath` set instead.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SettingsIssue, VueHtmlBridgeSettingsInput } from "./schema.js";

/** Injected filesystem access, so the loaders are testable without touching disk. */
export interface SettingsFileSystem {
  /**
   * Reads a file's contents as UTF-8. Resolves to `undefined` when the file
   * does not exist. Rejects for any other failure (e.g. a permissions
   * error) — the loader turns that rejection into a `file-unreadable`
   * issue rather than throwing.
   */
  readFile(absolutePath: string): Promise<string | undefined>;
}

export interface SettingsFileResult {
  settings: VueHtmlBridgeSettingsInput;
  issues: readonly SettingsIssue[];
  /** Absolute path of the file the settings came from, for watching and messages. */
  sourcePath?: string;
}

const WORKSPACE_SETTINGS_FILENAME = ".vue-html-bridge.json";
const PACKAGE_JSON_FILENAME = "package.json";
const PACKAGE_JSON_SETTINGS_FIELD = "vueHtmlBridge";

/**
 * A real `node:fs/promises`-backed `SettingsFileSystem`, for hosts (and for
 * this package's own real-fs integration tests) that want genuine
 * filesystem behavior rather than an in-memory fake.
 */
export function createNodeFileSystem(): SettingsFileSystem {
  return {
    async readFile(absolutePath) {
      try {
        return await readFile(absolutePath, "utf8");
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw error;
      }
    },
  };
}

/**
 * Discovery inside one workspace root (settings.md §5): tries
 * `.vue-html-bridge.json`, then the `vueHtmlBridge` field of `package.json`.
 * The first hit wins; the two are never merged with each other. Neither
 * file existing is not an issue at all — defaults apply. Never walks
 * upward past `workspaceRoot`.
 */
export async function loadWorkspaceSettingsFile(
  workspaceRoot: string,
  fileSystem: SettingsFileSystem,
): Promise<SettingsFileResult> {
  assertAbsolute("workspaceRoot", workspaceRoot);

  const dedicatedPath = join(workspaceRoot, WORKSPACE_SETTINGS_FILENAME);
  const dedicated = await readCandidate(fileSystem, dedicatedPath);
  if (dedicated.kind === "content") {
    return parseSettingsDocument(dedicated.content, dedicatedPath);
  }
  if (dedicated.kind === "unreadable") {
    // The dedicated file exists (it's the "hit"); we don't fall through to
    // package.json just because we couldn't read it.
    return {
      settings: {},
      issues: [fileUnreadable(dedicatedPath, dedicated.error)],
      sourcePath: dedicatedPath,
    };
  }

  const packageJsonPath = join(workspaceRoot, PACKAGE_JSON_FILENAME);
  const packageJson = await readCandidate(fileSystem, packageJsonPath);
  if (packageJson.kind === "missing") {
    return { settings: {}, issues: [] };
  }
  if (packageJson.kind === "unreadable") {
    return {
      settings: {},
      issues: [fileUnreadable(packageJsonPath, packageJson.error)],
      sourcePath: packageJsonPath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson.content);
  } catch (error) {
    return {
      settings: {},
      issues: [parseError(packageJsonPath, error)],
      sourcePath: packageJsonPath,
    };
  }
  if (!isPlainObject(parsed) || !(PACKAGE_JSON_SETTINGS_FIELD in parsed)) {
    // package.json exists but doesn't opt in: not a hit either, so this
    // behaves exactly like neither file existing.
    return { settings: {}, issues: [] };
  }
  const field = parsed[PACKAGE_JSON_SETTINGS_FIELD];
  if (!isPlainObject(field)) {
    return {
      settings: {},
      issues: [
        parseError(
          packageJsonPath,
          new Error(
            `"${PACKAGE_JSON_SETTINGS_FIELD}" in package.json must be an object.`,
          ),
        ),
      ],
      sourcePath: packageJsonPath,
    };
  }
  return {
    settings: field as VueHtmlBridgeSettingsInput,
    issues: [],
    sourcePath: packageJsonPath,
  };
}

/**
 * An explicit settings file given by path (e.g. the CLI's `--config`;
 * settings.md §5). Must contain the settings object itself — the same
 * shape as `.vue-html-bridge.json`. A `package.json` passed here is not
 * special-cased: the `vueHtmlBridge` extraction only exists in workspace
 * discovery.
 */
export async function loadSettingsFile(
  filePath: string,
  fileSystem: SettingsFileSystem,
): Promise<SettingsFileResult> {
  assertAbsolute("filePath", filePath);

  const candidate = await readCandidate(fileSystem, filePath);
  if (candidate.kind === "missing") {
    return {
      settings: {},
      issues: [fileMissing(filePath)],
      sourcePath: filePath,
    };
  }
  if (candidate.kind === "unreadable") {
    return {
      settings: {},
      issues: [fileUnreadable(filePath, candidate.error)],
      sourcePath: filePath,
    };
  }
  return parseSettingsDocument(candidate.content, filePath);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ReadCandidate =
  | { kind: "missing" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "content"; content: string };

async function readCandidate(
  fileSystem: SettingsFileSystem,
  absolutePath: string,
): Promise<ReadCandidate> {
  try {
    const content = await fileSystem.readFile(absolutePath);
    return content === undefined
      ? { kind: "missing" }
      : { kind: "content", content };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

function parseSettingsDocument(
  content: string,
  sourcePath: string,
): SettingsFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      settings: {},
      issues: [parseError(sourcePath, error)],
      sourcePath,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      settings: {},
      issues: [
        parseError(
          sourcePath,
          new Error("Settings file must contain a JSON object."),
        ),
      ],
      sourcePath,
    };
  }
  return {
    settings: parsed as VueHtmlBridgeSettingsInput,
    issues: [],
    sourcePath,
  };
}

function fileMissing(path: string): SettingsIssue {
  return {
    severity: "error",
    code: "file-missing",
    path: "",
    message: `Settings file not found: "${path}".`,
    sourcePath: path,
  };
}

function fileUnreadable(path: string, error: unknown): SettingsIssue {
  return {
    severity: "error",
    code: "file-unreadable",
    path: "",
    message: `Failed to read settings file "${path}": ${errorMessage(error)}`,
    sourcePath: path,
  };
}

function parseError(path: string, error: unknown): SettingsIssue {
  return {
    severity: "error",
    code: "parse-error",
    path: "",
    message: `Failed to parse settings file "${path}": ${errorMessage(error)}`,
    sourcePath: path,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function assertAbsolute(name: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be an absolute path, received "${path}".`);
  }
}
