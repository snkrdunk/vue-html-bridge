// Spike S2 criterion 6 (adapter-markuplint.md §3.1 item 6, §5): fix the first version
// of the generated-html profile's rule manifest against the pinned Markuplint major.
//
// The rule ID list and each rule's `category` come straight from the installed
// `@markuplint/rules` package (`meta.js` per rule) — not hand-typed — so a Markuplint
// upgrade that adds/removes/recategorizes a rule fails `ruleCount` / `unknownRuleIds`
// below instead of silently drifting from this manifest (mirrors criterion 7's drift
// test for configFilePatterns). The per-rule *decision* (keep vs. disable, and the
// `applicability` classification from monorepo.md §6.3 / adapter-markuplint.md §5-6)
// is product judgment, encoded in RULE_DECISIONS below and reviewed as such — see
// FINDINGS.md for the reasoning, in particular:
//
// - `markuplint:recommended-static-html` (not plain `recommended`) is the closest
//   built-in preset to what "generated-html" wants: it's `recommended` plus
//   `character-reference`/`end-tag` explicitly re-enabled on top of an (in 4.18.x)
//   EMPTY `code-styles` preset. Recommend basing the profile overlay on it.
// - Two rules get a non-default `applicability` per adapter-markuplint.md §5's own
//   examples: `no-use-event-handler-attr` (kept, but `source-representation` — a
//   Vue `@click` synthesized into `onclick="dummy-fn"` looks identical to a real
//   source `onclick`) and `no-refer-to-non-existent-id` (kept, but
//   `document-context` — the referenced id may live outside the fragment).
//   `heading-levels` and `landmark-roles` get the same `document-context`
//   treatment for the same reason (fragment-relative correctness only).
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesLibDir = path.join(here, "../node_modules/@markuplint/rules/lib");
const outputPath = path.join(
  here,
  "../../packages/adapter-markuplint/fixtures/rule-manifest.v1.json",
);

type Category =
  "validation" | "style" | "naming-convention" | "a11y" | "maintainability";
type Applicability =
  "html-semantics" | "source-representation" | "document-context";

interface RuleDecision {
  readonly keptInGeneratedHtmlProfile: boolean;
  readonly applicability?: Applicability;
  readonly reason: string;
}

// Curated Phase 0 decision per real rule ID (adapter-markuplint.md §5). Any rule
// the installed package has that is NOT listed here fails the test below, so an
// upgrade that adds a rule forces an explicit decision instead of an implicit default.
const RULE_DECISIONS: Record<string, RuleDecision> = {
  "attr-duplication": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, independent of authoring style.",
  },
  "attr-value-quotes": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Source-formatting-only (quote-style consistency); core's serializer emits one fixed quoting style, so this never meaningfully applies to generated output.",
  },
  "case-sensitive-attr-name": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Source-formatting-only (attribute-name casing convention), not generated-fragment validity.",
  },
  "case-sensitive-tag-name": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Source-formatting-only (tag-name casing convention); core.md §6.2 already preserves real casing during serialization.",
  },
  "character-reference": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "markuplint:recommended-static-html re-enables this over the (empty) code-styles preset for genuinely static output; keep for the same reason.",
  },
  "class-naming": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Enforces a project's authoring naming convention (e.g. BEM), not generated-HTML validity; opt in via profileRuleOverrides if desired.",
  },
  "deprecated-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model/spec validity.",
  },
  "deprecated-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model/spec validity.",
  },
  "disallowed-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity.",
  },
  doctype: {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a component fragment is never a full document (monorepo.md §6.5).",
  },
  "end-tag": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "markuplint:recommended-static-html re-enables this; matches core.md §6.2's guarantee that non-void elements always get an explicit end tag.",
  },
  "heading-levels": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "Whether heading nesting is sequential depends on where the fragment is inserted into a parent document (monorepo.md §6.5).",
  },
  "id-duplication": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Core to the feature: v-for's 2-item exemplar (core.md §4.5) exists specifically to surface duplicate static ids within one generated fragment.",
  },
  "ineffective-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Despite category:style, this flags an attribute placed on an element type where it has no effect — a content-model concern, not formatting.",
  },
  "invalid-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Attribute-value validity, the rule adapter-markuplint.md §5.4's example (aria-pressed) is built around.",
  },
  "label-has-control": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "landmark-roles": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "Landmark uniqueness/nesting correctness depends on the rest of the page the fragment is placed into.",
  },
  "neighbor-popovers": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "no-ambiguous-navigable-target-names": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "no-boolean-attr-value": {
    keptInGeneratedHtmlProfile: false,
    reason:
      'Source-formatting preference (e.g. disabled="disabled" vs. disabled); core.md §6.2 already always emits the bare boolean-attribute form, so this never fires against bridge output either way.',
  },
  "no-consecutive-br": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "no-default-value": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Source-formatting preference (omitting an attribute equal to its default), not a generated-HTML validity concern.",
  },
  "no-duplicate-dt": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "no-empty-palpable-content": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "no-hard-code-id": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Flags any literal id attribute; Vue templates routinely hardcode static ids intentionally, and the bridge's own id-duplication detection (core.md §4.5) depends on literal ids surviving into generated output.",
  },
  "no-orphaned-end-tag": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Well-formedness, fragment-local (core's serializer should never actually produce this, but keep it as a safety net).",
  },
  "no-refer-to-non-existent-id": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      'adapter-markuplint.md §5\'s own example: aria-controls/for/href="#id" may reference an id outside the current fragment.',
  },
  "no-use-event-handler-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "source-representation",
    reason:
      "adapter-markuplint.md §5's own example: a Vue @click synthesized into onclick=\"dummy-fn\" (core.md §5.3) is indistinguishable from a real source onclick by looking at the HTML string alone; the analyzer suppresses this using core's synthetic provenance (core.md §5.4), not the adapter.",
  },
  "permitted-contents": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "placeholder-label-option": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "require-accessible-name": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "require-datetime": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "required-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "required-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity; its document-root use (head>meta[charset]) only fires via a nodeRule selector that never matches a fragment lacking <head>, so no separate disable is needed.",
  },
  "required-h1": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a fragment legitimately may have zero h1 elements because the h1 lives in the surrounding page (monorepo.md §6.5).",
  },
  "table-row-column-alignment": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "use-list": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "wai-aria": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value validity, fragment-local; adapter-markuplint.md §6's aria-pressed example.",
  },
};

async function realRuleIdsWithCategory(): Promise<Map<string, Category>> {
  const entries = await readdir(rulesLibDir, { withFileTypes: true });
  const ruleIds = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out = new Map<string, Category>();
  for (const ruleId of ruleIds) {
    const metaUrl = new URL(
      `../node_modules/@markuplint/rules/lib/${ruleId}/meta.js`,
      import.meta.url,
    );
    const mod = (await import(metaUrl.href)) as {
      default: { category: Category };
    };
    out.set(ruleId, mod.default.category);
  }
  return out;
}

describe("S2 criterion 6: generated-html profile rule manifest v1", () => {
  it("covers every real rule in the installed @markuplint/rules package with an explicit decision", async () => {
    const realRules = await realRuleIdsWithCategory();
    const realRuleIds = [...realRules.keys()].sort();
    const decidedRuleIds = Object.keys(RULE_DECISIONS).sort();

    // A version bump that adds, removes, or renames a rule must fail here, not
    // silently drift (adapter-markuplint.md §5: "must not grow or shrink implicitly").
    expect(realRuleIds).toEqual(decidedRuleIds);
    expect(realRuleIds).toHaveLength(38);
  });

  it("writes packages/adapter-markuplint/fixtures/rule-manifest.v1.json, sorted by ruleId", async () => {
    const realRules = await realRuleIdsWithCategory();
    const manifest = [...realRules.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ruleId, category]) => ({
        ruleId,
        category,
        ...RULE_DECISIONS[ruleId]!,
      }));

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    expect(manifest).toHaveLength(38);
    expect(manifest.every((r) => r.ruleId === r.ruleId.toLowerCase())).toBe(
      true,
    );
    // applicability is only meaningful (and only set) when the rule is kept.
    for (const rule of manifest) {
      if (!rule.keptInGeneratedHtmlProfile) {
        expect(rule.applicability).toBeUndefined();
      } else {
        expect(rule.applicability).toBeDefined();
      }
    }
  });
});
