// The generated-html profile (adapter-markuplint.md §5): a small config overlay
// that disables rules only meaningful for hand-written source, keeping rules for
// HTML content model / attribute values / ARIA / ID references / accessibility.
// The exact rule list is a source-controlled manifest per Markuplint major
// version (ADR-0003) — it must not grow or shrink implicitly.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FromCodeOptions } from "markuplint";
import type { DiagnosticApplicability } from "@vue-html-bridge/validator-api";

// `@markuplint/ml-config`'s `Config` type isn't re-exported by `markuplint`'s
// public entry point, and isn't a direct dependency of this package — derive
// it structurally from the (exported) `FromCodeOptions.config` field instead.
type Config = NonNullable<FromCodeOptions["config"]>;

interface RuleManifestEntry {
  ruleId: string;
  category: string;
  keptInGeneratedHtmlProfile: boolean;
  applicability?: DiagnosticApplicability;
  reason: string;
}

const manifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/rule-manifest.v1.json",
);

// Loaded once at module init; the manifest is a small, static, committed fixture.
const RULE_MANIFEST: readonly RuleManifestEntry[] = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as readonly RuleManifestEntry[];

const DISABLED_RULE_IDS: readonly string[] = RULE_MANIFEST.filter(
  (entry) => !entry.keptInGeneratedHtmlProfile,
).map((entry) => entry.ruleId);

const APPLICABILITY_BY_RULE = new Map<string, DiagnosticApplicability>(
  RULE_MANIFEST.filter(
    (
      entry,
    ): entry is RuleManifestEntry & {
      applicability: DiagnosticApplicability;
    } => entry.applicability !== undefined,
  ).map((entry) => [entry.ruleId, entry.applicability]),
);

/**
 * Applicability is classified by rule meaning alone (validator-api §3.3's
 * default is html-semantics); a rule not in the manifest — e.g. because it
 * predates the pinned Markuplint version, or was never classified — stays at
 * that default rather than risk a false negative.
 */
export function classifyApplicability(
  ruleId: string | undefined,
): DiagnosticApplicability {
  if (!ruleId) return "html-semantics";
  return APPLICABILITY_BY_RULE.get(ruleId) ?? "html-semantics";
}

/**
 * Builds the "generated-html safety overlay" config (adapter-markuplint.md §5):
 * `markuplint:recommended-static-html` as the baseline extends target, plus the
 * manifest's disabled rules, plus any `profileRuleOverrides` — which apply last,
 * so they can re-enable a rule the overlay disabled. Passed via MLEngine's
 * `config` option (never `configFile`): a discovered/explicit user config,
 * passed alongside via `configFile`, is merged in *before* this object in
 * Markuplint's own resolution order, giving this overlay the correct priority
 * (§5: "Markuplint defaults < discovered/user config < generated-html safety
 * overlay < settings.profileRuleOverrides").
 */
export function generatedHtmlProfileOverlay(
  profileRuleOverrides: Readonly<Record<string, boolean>> = {},
): Config {
  const rules: Record<string, boolean> = {};
  for (const ruleId of DISABLED_RULE_IDS) rules[ruleId] = false;
  Object.assign(rules, profileRuleOverrides);
  return {
    extends: ["markuplint:recommended-static-html"],
    rules,
  };
}
