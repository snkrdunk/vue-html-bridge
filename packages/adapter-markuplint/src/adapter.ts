// The public HtmlValidatorAdapter (adapter-markuplint.md §2).
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { MLEngine } from "markuplint";
import {
  AdapterSessionFailureError,
  VALIDATOR_API_VERSION,
  type AdapterSessionContext,
  type ConfigWatchTarget,
  type HtmlValidatorAdapter,
  type ValidateHtmlRequest,
  type ValidateHtmlResult,
  type ValidatorSession,
} from "@vue-html-bridge/validator-api";
import { ConfigResolver } from "./config-resolver.js";
import { runValidate } from "./engine.js";
import {
  generatedHtmlProfileBaseline,
  generatedHtmlProfileOverlay,
} from "./generated-profile.js";
import type { MarkuplintAdapterSettings } from "./settings.js";

export const markuplintAdapter: HtmlValidatorAdapter<MarkuplintAdapterSettings> =
  {
    apiVersion: VALIDATOR_API_VERSION,
    id: "markuplint",
    displayName: "Markuplint",
    capabilities: {
      execution: "in-process",
      supportsCancellation: false,
      supportsConfigFiles: true,
      fragmentHandling: "native",
      // Conservative pending a dedicated concurrency spike (adapter-markuplint.md §2).
      maxConcurrentValidations: 1,
      configFilePatterns: [
        "**/.markuplintrc",
        "**/.markuplintrc.*",
        "**/.config/markuplintrc",
        "**/.config/markuplintrc.*",
        "**/markuplint.config.*",
        "**/package.json",
      ],
    },

    async createSession(
      context: AdapterSessionContext<MarkuplintAdapterSettings>,
    ): Promise<ValidatorSession> {
      // §7/§9.2 item 13: fail fast and structured, instead of an opaque
      // TypeError deep inside engine.ts, if a future installed Markuplint
      // version renames/removes API surface this adapter depends on.
      assertMarkuplintApiShape();

      const settings = context.settings;

      // §3.1: session creation resolves only the one thing that's resolvable
      // here — an explicit settings.configFile — and rejects with
      // AdapterSessionFailure if it's missing or fails to parse.
      if (settings.configFile) {
        const resolvedPath = resolvePath(
          context.workspaceRoot,
          settings.configFile,
        );
        if (!existsSync(resolvedPath)) {
          throw new AdapterSessionFailureError({
            code: "configuration-error",
            message: `Markuplint config file not found: ${resolvedPath}`,
            recoverable: true,
          });
        }
        await assertConfigParses(resolvedPath);
      }

      const resolver = new ConfigResolver(context.workspaceRoot, settings);
      const watchFiles = new Set<string>();
      let disposed = false;

      return {
        async validate(
          request: ValidateHtmlRequest,
          signal: AbortSignal,
        ): Promise<ValidateHtmlResult> {
          signal.throwIfAborted();
          if (disposed)
            throw new Error("Markuplint adapter session is disposed.");

          const resolved = await resolver.resolve(request.sourceFilename);
          if (resolved.failure) {
            // §7: config/plugin resolution itself failed before any
            // MLEngine validation run even started.
            return { diagnostics: [], failures: [resolved.failure] };
          }
          const { configFilePath } = resolved;
          const usesOverlay = settings.profile !== "as-configured";
          const overlay = usesOverlay
            ? generatedHtmlProfileOverlay(settings.profileRuleOverrides)
            : undefined;

          const outcome = await runValidate(
            request,
            {
              configFile: configFilePath,
              config: overlay,
              // §5's 4-tier priority (Markuplint defaults < discovered/user
              // config < generated-html overlay < profileRuleOverrides)
              // requires the *baseline* extends target to sit below the
              // user's own config — Markuplint's own merge order is
              // defaultConfig < configFile < config, so the baseline goes
              // here (see generatedHtmlProfileBaseline's doc comment for why
              // it must NOT be folded into `config` alongside the overlay's
              // own disables). When there's no overlay at all
              // (`profile: "as-configured"`), an inert `{}` here instead
              // suppresses a different Markuplint quirk: `noSearchConfig` +
              // a bare `configFile` (no `config`) still injects an
              // unrequested `markuplint:recommended` layer that would
              // outrank the explicit config in the merge order.
              defaultConfig: usesOverlay
                ? generatedHtmlProfileBaseline()
                : configFilePath
                  ? {}
                  : undefined,
              noSearchConfig: true,
              fix: false,
              locale: settings.locale,
            },
            context.logger,
          );
          signal.throwIfAborted();

          for (const file of outcome.configWatchFiles) watchFiles.add(file);
          const result: ValidateHtmlResult = {
            diagnostics: outcome.diagnostics,
            failures: outcome.failures,
            metadata: outcome.metadata,
          };
          return result;
        },

        getConfigWatchTargets(): readonly ConfigWatchTarget[] {
          return [...watchFiles]
            .sort()
            .map((absolutePath) => ({ absolutePath, kind: "config" as const }));
        },

        async dispose(): Promise<void> {
          disposed = true;
        },
      };
    },
  };

/**
 * §9.2 item 13: detect an incompatible Markuplint API shape (a future major
 * that renames/removes something this adapter depends on) up front, as
 * `validator-unavailable`, rather than a confusing raw TypeError from deep
 * inside engine.ts/config-resolver.ts. Not a full version-matrix check
 * (§3.2 handles the supported range via peerDependencies/CI) — just a cheap,
 * synchronous guard on the API surface actually used.
 */
function assertMarkuplintApiShape(): void {
  const REQUIRED_INSTANCE_METHODS = [
    "exec",
    "close",
    "on",
    "resolveConfig",
    "setCode",
  ] as const;
  const prototype = MLEngine.prototype as unknown as Readonly<
    Record<string, unknown>
  >;
  const missing = [
    ...(typeof MLEngine.fromCode === "function" ? [] : ["MLEngine.fromCode"]),
    ...REQUIRED_INSTANCE_METHODS.filter(
      (method) => typeof prototype[method] !== "function",
    ).map((method) => `MLEngine.prototype.${method}`),
  ];
  if (missing.length > 0) {
    throw new AdapterSessionFailureError({
      code: "validator-unavailable",
      message: `The installed Markuplint package is missing expected API members: ${missing.join(", ")}.`,
      // A settings change can't fix an incompatible package version, so
      // retrying session creation on the next reconfigure would not help
      // (validator-api.md §3.1's `recoverable` contract).
      recoverable: false,
    });
  }
}

async function assertConfigParses(configFile: string): Promise<void> {
  const engine = await MLEngine.fromCode("", {
    configFile,
    noSearchConfig: true,
    defaultConfig: {},
  });
  try {
    // Calling resolveConfig() directly (not exec()) never goes through
    // setup()/provide(), so the 'config-errors' event — only emitted there —
    // never fires here; ConfigSet.errs is populated either way, so read it
    // straight off the return value instead. Unlike setup()/provide(),
    // resolveConfig() also isn't guarded against a plugin/parser import
    // throwing synchronously (§7's "Plugin/parser import failure"), so that
    // case is handled explicitly below too, instead of rejecting createSession
    // with a raw, unstructured error.
    let configSet: Awaited<ReturnType<typeof engine.resolveConfig>>;
    try {
      configSet = await engine.resolveConfig(true);
    } catch (error) {
      throw new AdapterSessionFailureError({
        code: "configuration-error",
        message: `Markuplint config failed to resolve: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      });
    }
    const parseError = configSet.errs[0];
    if (parseError) {
      throw new AdapterSessionFailureError({
        code: "configuration-error",
        message: `Markuplint config failed to parse: ${parseError.message}`,
        recoverable: true,
      });
    }
  } finally {
    await engine.close();
  }
}
