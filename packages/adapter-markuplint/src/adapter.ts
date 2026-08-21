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
import { generatedHtmlProfileOverlay } from "./generated-profile.js";
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

          const { configFilePath } = await resolver.resolve(
            request.sourceFilename,
          );
          const overlay =
            settings.profile !== "as-configured"
              ? generatedHtmlProfileOverlay(settings.profileRuleOverrides)
              : undefined;

          const outcome = await runValidate(
            request,
            {
              configFile: configFilePath,
              config: overlay,
              // Suppresses a Markuplint quirk: `noSearchConfig` + a bare
              // `configFile` (no `config`) still injects an unrequested
              // `markuplint:recommended` layer that would outrank the explicit
              // config in the merge order. An inert `defaultConfig` avoids it.
              defaultConfig: configFilePath && !overlay ? {} : undefined,
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
    // straight off the return value instead.
    const configSet = await engine.resolveConfig(true);
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
