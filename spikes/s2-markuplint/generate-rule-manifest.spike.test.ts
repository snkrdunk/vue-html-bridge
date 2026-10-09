// Spike S2 criterion 6 (adapter-markuplint.md §3.1 item 6, §5): fix the first version
// of the generated-html profile rule manifest against the pinned Markuplint major.
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
//   `no-malformed-character-reference`/`no-unescaped-char`/`require-end-tag` explicitly
//   re-enabled on top of an (in 4.18.x) EMPTY `code-styles` preset. Recommend basing
//   the profile overlay on it.
// - ADR-0012 (v5 upgrade): the v5 rule-system redesign (#3989) renamed/split most
//   rules, tracked via `@markuplint/ml-config`'s rule-alias table. RULE_DECISIONS below
//   carries each old rule's verdict over to its new name(s), re-deriving only where the
//   split rules' document-dependency genuinely differs (e.g. required-h1's
//   missing-h1 half `require-h1` stays document-root-only/disabled, but its
//   duplicate-h1 half `no-duplicate-h1` is a real fragment-local violation and is kept).
// - Two rules get a non-default `applicability` per adapter-markuplint.md §5's own
//   examples: `no-event-handler-attr` (kept, but `source-representation` — a
//   Vue `@click` synthesized into `onclick="dummy-fn"` looks identical to a real
//   source `onclick`) and `no-refer-to-non-existent-id` (kept, but
//   `document-context` — the referenced id may live outside the fragment). Several
//   other rules (heading-levels's successor `no-skipped-heading-level`,
//   landmark-roles's successors, and most of the new document-root-only rules)
//   get the same non-default treatment for analogous reasons — see each entry's
//   own `reason` below.
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

// Curated decision per real rule ID (adapter-markuplint.md §5), re-derived for the
// v5.0.1 pin by ADR-0012. Any rule the installed package has that is NOT listed here
// fails the test below, so an upgrade that adds a rule forces an explicit decision
// instead of an implicit default.
const RULE_DECISIONS: Record<string, RuleDecision> = {
  "aria-prop-requires-role": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (global aria-* prop requiring a role); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "attr-order": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Source-formatting-only (attribute ordering convention), not generated-fragment validity.",
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
  "class-naming": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Enforces a project's authoring naming convention (e.g. BEM), not generated-HTML validity; opt in via profileRuleOverrides if desired.",
  },
  "consistent-table-row-length": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local. Split from table-row-column-alignment (v5 rule-system redesign).",
  },
  "element-supports-aria-prop": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (aria-* prop support per element); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "form-attr-references-form": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "May reference a form element outside the current fragment, like no-refer-to-non-existent-id.",
  },
  "head-element-order": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a fragment is never a full document with its own <head> (monorepo.md §6.5).",
  },
  "input-list-references-datalist": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "May reference a datalist element outside the current fragment, like no-refer-to-non-existent-id.",
  },
  "itemprop-requires-itemscope": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "Whether itemprop has a containing itemscope may depend on where the fragment is inserted into a parent document.",
  },
  "label-for-references-labelable": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "May reference a labelable control outside the current fragment, like no-refer-to-non-existent-id.",
  },
  "label-has-control": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "label-no-multiple-controls": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local (like label-has-control).",
  },
  "link-types": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "map-id-name-match": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, fragment-local — checks the element's own id/name attributes, not an external reference.",
  },
  "meta-charset-position": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a byte-offset-within-the-document check has no meaning for a fragment (monorepo.md §6.5).",
  },
  "meter-value-bounds": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "no-abstract-role": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (abstract-role usage); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-always-matching-source": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, fragment-local — checks sibling source elements within the same picture.",
  },
  "no-ambiguous-navigable-target-names": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "no-aria-hidden-on-hidden-until-found": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y attribute-value validity, fragment-local.",
  },
  "no-aria-on-presentational-children": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (aria-* on presentational children); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-aria-on-unsupported-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (role support per element); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-boolean-attr-value": {
    keptInGeneratedHtmlProfile: false,
    reason:
      'Source-formatting preference (e.g. disabled="disabled" vs. disabled); core.md §6.2 already always emits the bare boolean-attribute form, so this never fires against bridge output either way.',
  },
  "no-broken-fragment-link": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      'href="#id" may reference an id outside the current fragment, like no-refer-to-non-existent-id.',
  },
  "no-consecutive-br": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "no-content-after-body": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a fragment never has its own <body> end tag to follow (monorepo.md §6.5).",
  },
  "no-contradictory-aria-prop": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (contradictory aria-* prop combination); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-default-aria-value": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (aria-* prop matching its default value); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-default-value": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Source-formatting preference (omitting an attribute equal to its default), not a generated-HTML validity concern.",
  },
  "no-deprecated-aria-prop": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (deprecated aria-* prop usage); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-deprecated-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model/spec validity. Split from deprecated-attr (v5 rule-system redesign).",
  },
  "no-deprecated-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model/spec validity. Split from deprecated-element (v5 rule-system redesign).",
  },
  "no-deprecated-role": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (deprecated role usage); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-disallowed-ancestor": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity; fires only when both the element and its disallowed ancestor are present within the fragment — a strict subset of real violations, but never a false positive.",
  },
  "no-disallowed-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Attribute-eligibility validity (name known but disallowed on this element/condition). Split from invalid-attr (v5 rule-system redesign).",
  },
  "no-duplicate-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, independent of authoring style. Renamed from attr-duplication (v5 rule-system redesign).",
  },
  "no-duplicate-autofocus": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, fragment-local (like no-duplicate-dt/no-duplicate-id).",
  },
  "no-duplicate-dt": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "no-duplicate-h1": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, fragment-local — unlike require-h1's missing-h1 half, a fragment containing 2+ real h1 elements is a genuine violation regardless of document placement. Split from required-h1 (v5 rule-system redesign; the duplicate-h1 half).",
  },
  "no-duplicate-id": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Core to the feature: v-for's 2-item exemplar (core.md §4.5) exists specifically to surface duplicate static ids within one generated fragment. Renamed from id-duplication (v5 rule-system redesign).",
  },
  "no-duplicate-sibling-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, fragment-local — checks sibling elements within the same parent.",
  },
  "no-duplicate-visible-main": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local (like no-duplicate-dt/no-duplicate-id).",
  },
  "no-empty-palpable-content": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "no-empty-table-track": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local. Split from table-row-column-alignment (v5 rule-system redesign).",
  },
  "no-event-handler-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "source-representation",
    reason:
      "adapter-markuplint.md §5's own example: a Vue @click synthesized into onclick=\"dummy-fn\" (core.md §5.3) is indistinguishable from a real source onclick by looking at the HTML string alone; the analyzer suppresses this using core's synthetic provenance (core.md §5.4), not the adapter. Renamed from no-use-event-handler-attr (v5 rule-system redesign).",
  },
  "no-experimental-features": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Browser-compatibility/feature-maturity concern dependent on project-specific target-browser config, not generated-fragment validity.",
  },
  "no-extra-selected-options": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "no-focusable-in-aria-hidden": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (focusable content inside aria-hidden); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-hardcoded-id": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Flags any literal id attribute; Vue templates routinely hardcode static ids intentionally, and the bridge's own id-duplication detection (core.md §4.5) depends on literal ids surviving into generated output. Renamed from no-hard-code-id (v5 rule-system redesign).",
  },
  "no-ineffective-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Despite category:style, this flags an attribute placed on an element type where it has no effect — a content-model concern, not formatting. Renamed from ineffective-attr (v5 rule-system redesign).",
  },
  "no-input-file-value": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "no-invalid-aria-prop-value": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (aria-* prop value validity); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-invalid-attr-value": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Attribute-value validity, the rule adapter-markuplint.md §5.4's example (aria-pressed) is built around. Split from invalid-attr (v5 rule-system redesign).",
  },
  "no-malformed-character-reference": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "markuplint:recommended-static-html re-enables this over the (empty) code-styles preset for genuinely static output; keep for the same reason. Split from character-reference (v5 rule-system redesign).",
  },
  "no-mismatched-aspect-ratio": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Validates img/source dimensions against the real referenced image file; a generated/virtual fragment's image paths aren't resolvable on disk (ADR-0003 criterion 1), so this would either silently false-negative or fail trying to resolve a nonexistent file.",
  },
  "no-mixed-srcset-descriptors": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "no-nested-top-level-landmark": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "Landmark uniqueness/nesting correctness depends on the rest of the page the fragment is placed into. Split from landmark-roles (v5 rule-system redesign).",
  },
  "no-nonstandard-features": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Browser-compatibility/feature-maturity concern dependent on project-specific target-browser config, not generated-fragment validity.",
  },
  "no-obsolete-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model/spec validity. Split from deprecated-attr (v5 rule-system redesign).",
  },
  "no-obsolete-doctype": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only, same as require-doctype: a fragment never has a DOCTYPE to begin with, so this half never has anything to check either. Split from doctype (v5 rule-system redesign).",
  },
  "no-obsolete-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model/spec validity. Split from deprecated-element (v5 rule-system redesign).",
  },
  "no-orphaned-end-tag": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Well-formedness, fragment-local (core's serializer should never actually produce this, but keep it as a safety net).",
  },
  "no-prohibited-naming": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (ARIA naming prohibition); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-pseudo-list": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local. Renamed from use-list (v5 rule-system redesign).",
  },
  "no-redundant-accessible-name": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local — checks the element's own accessible-name sources.",
  },
  "no-redundant-aria-prop": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (aria-* prop matching implicit value); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-redundant-role": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (role matching implicit semantics); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-refer-to-non-existent-id": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      'adapter-markuplint.md §5\'s own example: aria-controls/for/href="#id" may reference an id outside the current fragment.',
  },
  "no-restricted-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Purely user-defined denylist (disallowAttrs); never fires unless configured, so enabling it by default is harmless. Split from invalid-attr (v5 rule-system redesign).",
  },
  "no-restricted-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity. Renamed from disallowed-element (v5 rule-system redesign).",
  },
  "no-skipped-heading-level": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "Whether heading nesting is sequential depends on where the fragment is inserted into a parent document (monorepo.md §6.5). Renamed from heading-levels (v5 rule-system redesign).",
  },
  "no-stray-head-or-body-tag": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: concerns a stray <head>/<body> tag, meaningless for a fragment that never contains a <head>/<body> (monorepo.md §6.5).",
  },
  "no-table-cell-overlap": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local. Split from table-row-column-alignment (v5 rule-system redesign).",
  },
  "no-table-span-overflow": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local. Split from table-row-column-alignment (v5 rule-system redesign).",
  },
  "no-unclosed-element-at-eof": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Well-formedness, fragment-local (like no-orphaned-end-tag, a safety net the serializer should normally avoid triggering).",
  },
  "no-unescaped-char": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "markuplint:recommended-static-html re-enables this over the (empty) code-styles preset for genuinely static output; keep for the same reason. Split from character-reference (v5 rule-system redesign).",
  },
  "no-unknown-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Attribute-name validity. Split from invalid-attr (v5 rule-system redesign); the rule adapter-markuplint.md §5.4's example (aria-pressed) is built around this family.",
  },
  "no-unknown-role": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (role existence); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "no-unpaired-srcset-sizes": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "no-unsupported-browser-features": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Browser-compatibility concern dependent on project-specific browserslist config this adapter doesn't provide, not generated-fragment validity.",
  },
  "permitted-contents": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "permitted-roles": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (role permitted on the element); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "placeholder-label-option": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Content-model validity, fragment-local.",
  },
  "progress-value-bounds": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Attribute-value validity, fragment-local (like meter-value-bounds).",
  },
  "require-accessible-name": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "A11y content-model, fragment-local.",
  },
  "require-adjacent-popover": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local. Renamed from neighbor-popovers (v5 rule-system redesign).",
  },
  "require-ancestor": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "A required ancestor may exist outside the current fragment, like landmark-roles/no-refer-to-non-existent-id.",
  },
  "require-aria-prop": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (required aria-* props for a role); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "require-attr": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity, fragment-local. Renamed from required-attr (v5 rule-system redesign).",
  },
  "require-datetime": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "require-dialog-autofocus": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "A11y content-model, fragment-local — checks the dialog's own descendants.",
  },
  "require-doctype": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a component fragment is never a full document (monorepo.md §6.5) and never carries a DOCTYPE, so this would fire on every single fragment. Split from doctype (v5 rule-system redesign; renamed from the old doctype rule's presence-check half).",
  },
  "require-element": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "Content-model validity; its document-root use (head>meta[charset]) only fires via a nodeRule selector that never matches a fragment lacking <head>, so no separate disable is needed. Renamed from required-element (v5 rule-system redesign).",
  },
  "require-end-tag": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "markuplint:recommended-static-html re-enables this; matches core.md §6.2's guarantee that non-void elements always get an explicit end tag. Renamed from end-tag (v5 rule-system redesign).",
  },
  "require-h1": {
    keptInGeneratedHtmlProfile: false,
    reason:
      "Document-root-only: a fragment legitimately may have zero h1 elements because the h1 lives in the surrounding page (monorepo.md §6.5). Split from required-h1 (v5 rule-system redesign; the missing-h1 half).",
  },
  "require-landmark-label": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "Landmark uniqueness/labeling correctness depends on the rest of the page the fragment is placed into. Split from landmark-roles (v5 rule-system redesign).",
  },
  "require-owned-elements": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (required owned elements for a role); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "require-parent-role": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (required parent role); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "role-supports-aria-prop": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (aria-* prop support per role); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "sizes-auto-requires-lazy-loading": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason: "Attribute-value validity, fragment-local.",
  },
  "tab-requires-tabpanel": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      "ARIA attribute-value/role validity, fragment-local (tab role requiring an owned tabpanel); adapter-markuplint.md §6's aria-pressed example now reports under no-invalid-aria-prop-value. Split from wai-aria (v5 rule-system redesign).",
  },
  "usemap-references-map": {
    keptInGeneratedHtmlProfile: true,
    applicability: "document-context",
    reason:
      "May reference a map element outside the current fragment, like no-refer-to-non-existent-id.",
  },
  "valid-importmap": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      'Content validity of a <script type="importmap"> element\'s own body, fragment-local.',
  },
  "valid-speculation-rules": {
    keptInGeneratedHtmlProfile: true,
    applicability: "html-semantics",
    reason:
      'Content validity of a <script type="speculationrules"> element\'s own body, fragment-local.',
  },
};

/**
 * v5's rule-system redesign (#3989) left a handful of directories under
 * `@markuplint/rules/lib` that are no longer standalone rules — just shared
 * helper modules the rules split out of them still import internally
 * (e.g. `landmark-roles/roles.js`, `wai-aria/checkings/*`). They have no
 * `meta.js`, so they are not real rule IDs and must not be treated as ones;
 * skip (rather than fail importing) any directory missing it.
 */
async function realRuleIdsWithCategory(): Promise<Map<string, Category>> {
  const entries = await readdir(rulesLibDir, { withFileTypes: true });
  const candidateIds = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out = new Map<string, Category>();
  for (const ruleId of candidateIds) {
    const metaUrl = new URL(
      `../node_modules/@markuplint/rules/lib/${ruleId}/meta.js`,
      import.meta.url,
    );
    let mod: { default: { category: Category } };
    try {
      mod = (await import(metaUrl.href)) as { default: { category: Category } };
    } catch {
      continue;
    }
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
    expect(realRuleIds).toHaveLength(107);
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

    expect(manifest).toHaveLength(107);
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
