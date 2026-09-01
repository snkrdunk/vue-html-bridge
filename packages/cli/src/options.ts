// The CLI's entire flag surface (cli.md §4.2, §4.3) lives here — this is the
// only module that knows a flag's *name*. It turns argv into:
//  - a `VueHtmlBridgeSettingsInput` layer for every settings-mapped flag
//    except the three validator flags (§4.3 is a documented exception to
//    normal array-replacement layering — see `ValidatorFlagOp`/
//    `applyValidatorFlagOps`, applied by the caller *after* `resolveSettings`
//    runs, on top of the already-resolved `validators[]`);
//  - the CLI-only options (`--config`, `--workspace-root`, `--format`,
//    `--fail-on`, `--untrusted`, `--no-color`);
//  - `--help`/`--version` flags and usage errors.
//
// `resolveSettings` (settings.md §4) does the actual type/range validation
// for every settings-mapped flag once it receives this layer — a malformed
// numeric flag (e.g. `--max-concurrency abc`) is deliberately *not*
// special-cased into a distinct "usage error" here: it becomes `NaN`, which
// resolveSettings' own `Number.isInteger` check rejects as an `invalid-type`
// issue, fatal for the CLI (§4.1) exactly like a bad config-file value. This
// keeps "resolution semantics are exactly those of resolveSettings; the CLI
// adds nothing" true even for flag-sourced values. CLI-only enum flags
// (`--format`, `--fail-on`) and the validator-setting dotted-path grammar
// have no settings-schema counterpart to delegate to, so *those* are
// rejected here, as usage errors.
import type {
  ResolvedValidatorSetting,
  VueHtmlBridgeSettingsInput,
} from "@vue-html-bridge/settings";
import type { FailOnThreshold } from "./exit-codes.js";

export type OutputFormat = "text" | "ndjson";

export type ValidatorFlagOp =
  | { kind: "enable"; entryKey: string }
  | { kind: "disable"; entryKey: string }
  | {
      kind: "set-setting";
      entryKey: string;
      path: readonly string[];
      value: unknown;
    };

export interface ParsedCliOptions {
  /** The flags layer, minus the three validator flags (see module doc). */
  settingsInput: VueHtmlBridgeSettingsInput;
  /** In command-line order, applied by the caller after `resolveSettings` (§4.3). */
  validatorOps: readonly ValidatorFlagOp[];
  positionalArgs: readonly string[];
  configPath?: string;
  workspaceRoot?: string;
  /** `--emit-html <dir>` (plan.md T3, ADR-0011). Opt-in; undefined = no change to default behavior. */
  emitHtmlDir?: string;
  format: OutputFormat;
  failOn: FailOnThreshold;
  untrusted: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
}

export type ParseArgvResult =
  | { kind: "ok"; options: ParsedCliOptions }
  | { kind: "error"; message: string };

const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "ndjson"];
const FAIL_ON_VALUES: readonly FailOnThreshold[] = [
  "error",
  "warning",
  "info",
  "hint",
  "never",
];

/**
 * Splits a `--flag=value` token into `["--flag", "value"]` at the *first*
 * `=` only — a `--validator-setting` value can legitimately contain further
 * `=` characters (e.g. JSON `{"a":"b=c"}`), so this must never behave like a
 * naive `token.split("=")`.
 */
function expandEquals(argv: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const token of argv) {
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        expanded.push(token.slice(0, eq), token.slice(eq + 1));
        continue;
      }
    }
    expanded.push(token);
  }
  return expanded;
}

function err(message: string): ParseArgvResult {
  return { kind: "error", message };
}

export function parseArgv(argv: readonly string[]): ParseArgvResult {
  const tokens = expandEquals(argv);

  const positionalArgs: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  const customElements: string[] = [];
  const validatorOps: ValidatorFlagOp[] = [];
  let maxConcurrencyRaw: number | undefined;
  let warnVariantCountRaw: number | undefined;
  let externalAdapters: string | undefined;
  let configPath: string | undefined;
  let workspaceRoot: string | undefined;
  let emitHtmlDir: string | undefined;
  let format: OutputFormat | undefined;
  let failOn: FailOnThreshold | undefined;
  let untrusted = false;
  let noColor = false;
  let help = false;
  let version = false;

  let i = 0;
  function takeValue(): string | undefined {
    i += 1;
    return tokens[i];
  }

  while (i < tokens.length) {
    const token = tokens[i]!;
    switch (token) {
      case "--help":
        help = true;
        break;
      case "--version":
        version = true;
        break;
      case "--untrusted":
        untrusted = true;
        break;
      case "--no-color":
        noColor = true;
        break;
      case "--include": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        include.push(value);
        break;
      }
      case "--exclude": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        exclude.push(value);
        break;
      }
      case "--custom-elements": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        customElements.push(value);
        break;
      }
      case "--max-concurrency": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        maxConcurrencyRaw = Number(value);
        break;
      }
      case "--warn-variant-count": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        warnVariantCountRaw = Number(value);
        break;
      }
      case "--external-adapters": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        externalAdapters = value;
        break;
      }
      case "--config": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        configPath = value;
        break;
      }
      case "--workspace-root": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        workspaceRoot = value;
        break;
      }
      case "--emit-html": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        emitHtmlDir = value;
        break;
      }
      case "--format": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        if (!(OUTPUT_FORMATS as readonly string[]).includes(value)) {
          return err(
            `"--format" must be one of ${OUTPUT_FORMATS.join(", ")}; got "${value}".`,
          );
        }
        format = value as OutputFormat;
        break;
      }
      case "--fail-on": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        if (!(FAIL_ON_VALUES as readonly string[]).includes(value)) {
          return err(
            `"--fail-on" must be one of ${FAIL_ON_VALUES.join(", ")}; got "${value}".`,
          );
        }
        failOn = value as FailOnThreshold;
        break;
      }
      case "--validator": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        if (value.length === 0)
          return err(`"--validator" requires a non-empty entry key.`);
        validatorOps.push({ kind: "enable", entryKey: value });
        break;
      }
      case "--disable-validator": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        if (value.length === 0) {
          return err(`"--disable-validator" requires a non-empty entry key.`);
        }
        validatorOps.push({ kind: "disable", entryKey: value });
        break;
      }
      case "--validator-setting": {
        const value = takeValue();
        if (value === undefined) return err(`"${token}" requires a value.`);
        const parsed = parseValidatorSettingFlag(value);
        if (typeof parsed === "string") return err(parsed);
        validatorOps.push(parsed);
        break;
      }
      default:
        if (token.startsWith("-") && token !== "-") {
          return err(`Unknown option "${token}".`);
        }
        positionalArgs.push(token);
    }
    i += 1;
  }

  // A non-numeric value (e.g. "abc") becomes `NaN` here, which is still
  // `typeof "number"` — resolveSettings' own invalid-type/out-of-range issue
  // reporting (§4.1) rejects it exactly like a bad config-file value; see
  // the module doc comment above.
  const settingsInput: VueHtmlBridgeSettingsInput = {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(customElements.length > 0 ? { customElements } : {}),
    ...(maxConcurrencyRaw !== undefined
      ? { maxConcurrency: maxConcurrencyRaw }
      : {}),
    ...(warnVariantCountRaw !== undefined
      ? { warnVariantCount: warnVariantCountRaw }
      : {}),
    ...(externalAdapters !== undefined
      ? {
          externalAdapters:
            externalAdapters as VueHtmlBridgeSettingsInput["externalAdapters"],
        }
      : {}),
  };

  return {
    kind: "ok",
    options: {
      settingsInput,
      validatorOps,
      positionalArgs,
      configPath,
      workspaceRoot,
      emitHtmlDir,
      format: format ?? "text",
      failOn: failOn ?? "error",
      untrusted,
      noColor,
      help,
      version,
    },
  };
}

// ---------------------------------------------------------------------------
// §4.3: validator flags
// ---------------------------------------------------------------------------

/**
 * Parses `<entry-key>.<path>=<value>`. Splits at the *first* `=` for the
 * value boundary (a JSON value can itself contain `=`), then at the *first*
 * `.` for the entry-key/path boundary (entry keys never contain `.` in
 * practice — an npm package specifier or the built-in id `"markuplint"` —
 * and a path segment that itself contains a literal `.` is documented as
 * unaddressable by flag, cli.md §4.3).
 */
function parseValidatorSettingFlag(raw: string): ValidatorFlagOp | string {
  const eq = raw.indexOf("=");
  if (eq < 0) {
    return `"--validator-setting" requires "<entry-key>.<path>=<value>"; got "${raw}".`;
  }
  const left = raw.slice(0, eq);
  const rawValue = raw.slice(eq + 1);
  const dot = left.indexOf(".");
  if (dot < 0) {
    return `"--validator-setting" requires "<entry-key>.<path>=<value>"; missing "." in "${left}".`;
  }
  const entryKey = left.slice(0, dot);
  const pathText = left.slice(dot + 1);
  if (entryKey.length === 0) {
    return `"--validator-setting" requires a non-empty entry key; got "${raw}".`;
  }
  const path = parseDottedPath(pathText);
  if (typeof path === "string") return path;
  return {
    kind: "set-setting",
    entryKey,
    path,
    value: parseFlagValue(rawValue),
  };
}

const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const ARRAY_INDEX_SEGMENT = /[[\]]/;

/**
 * The dotted-path grammar (cli.md §4.3): one or more non-empty segments
 * separated by `.`. `__proto__`/`constructor`/`prototype` segments and
 * bracketed array-index syntax (`rules[0]`) are rejected outright rather
 * than silently accepted as literal (surprising) object keys.
 */
export function parseDottedPath(path: string): readonly string[] | string {
  if (path.length === 0) return "A validator-setting path must not be empty.";
  const segments = path.split(".");
  for (const segment of segments) {
    if (segment.length === 0) {
      return `A validator-setting path must not contain empty segments; got "${path}".`;
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      return `The validator-setting path segment "${segment}" is not allowed.`;
    }
    if (ARRAY_INDEX_SEGMENT.test(segment)) {
      return `Array indices are not supported in "--validator-setting" paths (segment "${segment}"); use the config file instead.`;
    }
  }
  return segments;
}

/** JSON-with-string-fallback (cli.md §4.3): `false` parses as a boolean, an unparsable token stays a plain string. */
export function parseFlagValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A "plain object" for merge purposes: either a null-prototype object (what
 * this function itself produces) or an ordinary `Object.prototype`-based
 * object (what a config file's `JSON.parse` or an existing `validators[].settings`
 * value already is). Anything else (array, class instance, primitive) is not
 * safe to treat as an extendable container.
 */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || proto === Object.prototype;
}

/** Copies `source`'s own enumerable keys into a fresh null-prototype object, via `defineProperty` (never `[[Set]]`, so a literal "__proto__" own key copies as inert data, exactly as `JSON.parse` itself already treats it). */
function toNullProtoCopy(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const target = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}

/**
 * Builds (or extends) a nested settings object using own-property
 * assignment (`Object.defineProperty`, which bypasses the prototype chain
 * entirely) on null-prototype intermediate objects — so even if a forbidden
 * segment slipped past `parseDottedPath` somehow, assignment itself could
 * never reach `Object.prototype`. An existing value at an intermediate
 * position is preserved (copied into a fresh null-prototype object, so the
 * original is never mutated) whenever it is itself a plain object —
 * regardless of whether it came from a previous `deepSetOwn` call (null
 * prototype) or from a config file / earlier `validators[].settings`
 * (ordinary `Object.prototype`); anything else at that position (a scalar,
 * array, or other non-plain value) is replaced (documented last-write-wins
 * for a type mismatch).
 */
export function deepSetOwn(
  root: unknown,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = isMergeableObject(root)
    ? toNullProtoCopy(root)
    : (Object.create(null) as Record<string, unknown>);
  let cursor: Record<string, unknown> = base;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]!;
    const existing = Object.prototype.hasOwnProperty.call(cursor, key)
      ? cursor[key]
      : undefined;
    const next: Record<string, unknown> = isMergeableObject(existing)
      ? toNullProtoCopy(existing)
      : (Object.create(null) as Record<string, unknown>);
    Object.defineProperty(cursor, key, {
      value: next,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    cursor = next;
  }
  const lastKey = segments[segments.length - 1]!;
  Object.defineProperty(cursor, lastKey, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return base;
}

/**
 * cli.md §4.3: applies the three validator flags as per-entry modifications
 * on top of the *already-resolved* `validators[]` (the caller runs this
 * after `resolveSettings`, never as another layer fed into it — a documented
 * exception to normal array-replacement layering). Ops are applied in
 * command-line order, regardless of which of the three flags produced them.
 * `--validator`/`--disable-validator`/`--validator-setting` all add a fresh
 * entry (`enabled: true` by default, matching settings.md §3.1's own default
 * for a `validators[]` entry) when the entry key names no existing entry —
 * documented judgment call: cli.md §4.3 says this explicitly only for
 * `--validator`, but there would otherwise be nothing for
 * `--disable-validator`/`--validator-setting` alone to act on for an adapter
 * not already in the resolved config.
 */
export function applyValidatorFlagOps(
  validators: readonly ResolvedValidatorSetting[],
  ops: readonly ValidatorFlagOp[],
): readonly ResolvedValidatorSetting[] {
  const entries = new Map<string, ResolvedValidatorSetting>();
  const order: string[] = [];
  for (const entry of validators) {
    entries.set(entry.adapter, entry);
    order.push(entry.adapter);
  }

  function ensureEntry(entryKey: string): ResolvedValidatorSetting {
    const existing = entries.get(entryKey);
    if (existing) return existing;
    const created: ResolvedValidatorSetting = {
      adapter: entryKey,
      enabled: true,
    };
    entries.set(entryKey, created);
    order.push(entryKey);
    return created;
  }

  for (const op of ops) {
    const entry = ensureEntry(op.entryKey);
    switch (op.kind) {
      case "enable":
        entries.set(op.entryKey, { ...entry, enabled: true });
        break;
      case "disable":
        entries.set(op.entryKey, { ...entry, enabled: false });
        break;
      case "set-setting":
        entries.set(op.entryKey, {
          ...entry,
          // structuredClone converts the null-prototype build result (see
          // deepSetOwn's doc comment) into an ordinary Object.prototype-based
          // object before it leaves this module — downstream adapter-settings
          // validation (e.g. Ajv-style `value.hasOwnProperty(...)` calls) must
          // never be handed a null-prototype object it wasn't built for. The
          // clone itself cannot reintroduce prototype pollution: it only ever
          // copies the null-prototype object's own enumerable properties.
          settings: structuredClone(
            deepSetOwn(entry.settings, op.path, op.value),
          ),
        });
        break;
    }
  }

  return order.map((key) => entries.get(key)!);
}

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

export const HELP_TEXT = `Usage: vue-html-bridge [options] [file|dir|glob ...]

Runs the same vue-html-bridge analysis as the language server, one-shot.

Positional arguments:
  file|dir|glob            Files, directories (expanded to <dir>/**/*.vue), or
                            globs to analyze. Replaces the "include" setting
                            when given. With none, "include" (default
                            "**/*.vue") is used, relative to the workspace root.

Settings flags:
  --include <glob>          Repeatable. Same role as a positional argument.
  --exclude <glob>          Repeatable. Always applies (default: **/node_modules/**).
  --max-concurrency <n>     Adapter-level concurrency passed to the analyzer.
  --warn-variant-count <n>  Passed to core's variant-generation options.
  --custom-elements <name>  Repeatable. Tag name or glob.
  --external-adapters <disabled|trusted-workspace-only>

Validator flags:
  --validator <entry-key>              Repeatable. Marks an entry enabled.
  --disable-validator <entry-key>      Repeatable. Marks an entry disabled.
  --validator-setting <entry-key>.<path>=<value>
                                        Repeatable. <value> is parsed as JSON,
                                        falling back to a plain string.

Other options:
  --config <path>            Explicit settings file; replaces discovery.
  --workspace-root <dir>     Default: the current working directory.
  --emit-html <dir>          Write each generated HTML variant (plus a JSON
                              decisions/mapping sidecar) under <dir>, for
                              debugging (ADR-0011). Opt-in; no effect on
                              default behavior when omitted.
  --format <text|ndjson>     Default: text.
  --fail-on <error|warning|info|hint|never>
                              Lowest severity that causes exit code 1. Default: error.
  --untrusted                 Restricted trust: no external adapters, bundled
                              Markuplint defaults only.
  --no-color                  Disable color output.
  --help                      Print this message and exit 0.
  --version                   Print the version and exit 0.
`;
