// Settings sourcing (cli.md §4.1): loads the config-file layer (explicit
// `--config`, or discovered `.vue-html-bridge.json`/`package.json#vueHtmlBridge`),
// merges it with the flags layer through the shared `resolveSettings`, then
// applies the two CLI-specific, post-resolution steps that are *not* part of
// `resolveSettings` itself: the §4.3 validator-flag patches and the §5
// `--untrusted` trust forcing. `resolveSettings`'s own semantics are used
// unchanged — this module decides only what the CLI does with the result
// (fatal vs. warn, per §4.1).
import { isAbsolute, resolve } from "node:path";
import {
  createNodeFileSystem,
  loadSettingsFile,
  loadWorkspaceSettingsFile,
  resolveSettings,
  type ResolvedVueHtmlBridgeSettings,
  type SettingsIssue,
  type VueHtmlBridgeSettingsInput,
} from "@vue-html-bridge/settings";
import { applyValidatorFlagOps, type ValidatorFlagOp } from "./options.js";

export interface ResolveCliSettingsOptions {
  /** Absolute. */
  workspaceRoot: string;
  /** Absolute; `--config`'s relative path is resolved against this (cli.md §4.1 resolves it "from the current working directory"). */
  cwd: string;
  /** Raw `--config` value, if given. */
  configPath?: string;
  /** The flags layer built by options.ts, minus the three validator flags. */
  flagsInput: VueHtmlBridgeSettingsInput;
  validatorOps: readonly ValidatorFlagOp[];
  untrusted: boolean;
}

export type ResolveCliSettingsResult =
  | {
      kind: "ok";
      settings: ResolvedVueHtmlBridgeSettings;
      workspaceTrusted: boolean;
      /** Warning-severity issues (settings.md §4), for the caller to print to stderr. */
      warnings: readonly SettingsIssue[];
    }
  | {
      kind: "fatal";
      /** Every issue (error-severity ones are why this run is fatal; warnings are included too, for a complete stderr report). */
      issues: readonly SettingsIssue[];
    };

export async function resolveCliSettings(
  options: ResolveCliSettingsOptions,
): Promise<ResolveCliSettingsResult> {
  const fileSystem = createNodeFileSystem();

  const configLayerResult =
    options.configPath !== undefined
      ? await loadSettingsFile(
          isAbsolute(options.configPath)
            ? options.configPath
            : resolve(options.cwd, options.configPath),
          fileSystem,
        )
      : await loadWorkspaceSettingsFile(options.workspaceRoot, fileSystem);

  const { settings, issues } = resolveSettings([
    configLayerResult.settings,
    options.flagsInput,
  ]);
  const allIssues = [...configLayerResult.issues, ...issues];
  const hasFatalIssue = allIssues.some((issue) => issue.severity === "error");
  if (hasFatalIssue) {
    return { kind: "fatal", issues: allIssues };
  }

  const patchedValidators = applyValidatorFlagOps(
    settings.validators,
    options.validatorOps,
  );

  // §5: `--untrusted` forces externalAdapters to "disabled" regardless of
  // what resolution produced — it "wins over any conflicting trust-related
  // flag or setting" — and every other resolved field is left untouched
  // (host-neutral settings apply the same either way, per §5).
  const workspaceTrusted = !options.untrusted;
  const externalAdapters = options.untrusted
    ? ("disabled" as const)
    : settings.externalAdapters;

  return {
    kind: "ok",
    settings: {
      ...settings,
      validators: patchedValidators,
      externalAdapters,
    },
    workspaceTrusted,
    warnings: allIssues.filter((issue) => issue.severity === "warning"),
  };
}
