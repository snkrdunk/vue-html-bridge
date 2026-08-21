// Runs one validation through the real MLEngine API (adapter-markuplint.md
// §3, §6, §7) and converts its result into the validator-api shape.
import { isAbsolute } from "node:path";
import { MLEngine } from "markuplint";
import type { FromCodeOptions } from "markuplint";
import type {
  AdapterFailure,
  AdapterLogger,
  ValidateHtmlRequest,
  ValidateHtmlResult,
} from "@vue-html-bridge/validator-api";
import { toGeneratedDiagnostics } from "./violation-converter.js";

const CONFIG_ERROR_RULE_ID = "config-error";
const ENGINE_ERROR_RULE_ID = "@markuplint/ml-core";

export interface ValidateOutcome extends ValidateHtmlResult {
  /** Absolute paths this run's config resolution actually depended on. */
  configWatchFiles: readonly string[];
}

export async function runValidate(
  request: ValidateHtmlRequest,
  engineOptions: FromCodeOptions,
  logger: AdapterLogger,
): Promise<ValidateOutcome> {
  const engine = await MLEngine.fromCode(request.html, {
    ...engineOptions,
    name: request.virtualFilename,
  });
  let configWatchFiles: readonly string[] = [];
  engine.on("config", (_filePath, configSet) => {
    configWatchFiles = [...configSet.files].filter((file) => isAbsolute(file));
  });
  try {
    const result = await engine.exec();
    if (result === null) {
      // exec() returns null for excludeFiles matches, a missing file, or an
      // unmatched parser extension (§6.3) — Markuplint's public API does not
      // distinguish which, and our in-memory `.html`-named input makes the
      // latter two practically unreachable, so this is treated as the
      // documented "excluded by config" case: no diagnostics, no failures.
      return {
        diagnostics: [],
        failures: [],
        metadata: { excluded: true },
        configWatchFiles,
      };
    }

    const failures: AdapterFailure[] = [];
    const configErrorViolation = result.violations.find(
      (violation) => violation.ruleId === CONFIG_ERROR_RULE_ID,
    );
    if (configErrorViolation) {
      failures.push({
        code: "configuration-error",
        message: configErrorViolation.message,
        recoverable: true,
      });
    }
    const engineErrorViolation = result.violations.find(
      (violation) => violation.ruleId === ENGINE_ERROR_RULE_ID,
    );
    if (engineErrorViolation) {
      failures.push({
        code: "execution-error",
        message: "Markuplint failed to verify the generated document.",
        recoverable: true,
      });
    }

    const realViolations = result.violations.filter(
      (violation) =>
        violation.ruleId !== CONFIG_ERROR_RULE_ID &&
        violation.ruleId !== ENGINE_ERROR_RULE_ID,
    );
    return {
      diagnostics: toGeneratedDiagnostics(request.html, realViolations, logger),
      failures,
      configWatchFiles,
    };
  } finally {
    await engine.close();
  }
}
