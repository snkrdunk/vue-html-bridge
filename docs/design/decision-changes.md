# List of Changes from the Old Design

Status: Proposed
Last updated: 2026-08-18

This document records which decisions from `Design Document_ vue-html-bridge.md` (at the repository root) were changed on purpose in this directory's design, and why.

## Baseline for comparison

The baseline is **Rev. 8** of the root document (the latest version as of 2026-08-18). This list originally used Rev. 5 as the baseline, but the root document itself was revised through Rev. 6-8 and now includes the Decision Model, `v-for` 0/1/2, and other changes — the Rev. 5 text no longer exists. Decision changes made inside the root document between Rev. 5 and Rev. 8 are part of that document's own revision history, and are out of scope for this list.

Once the repository is under git management, the baseline should be pinned to a commit hash. Any difference from Rev. 8 not listed here is a carry-over gap: once found, it should either be restored into the core design or added to this list.

## Changed decisions (Rev. 8 → docs/design)

| # | Item | Old decision (Rev. 8) | New decision | Reason for change |
| --- | --- | --- | --- | --- |
| 1 | Variant deduplication | Merge variants only when both `html` and the map are identical | core does not merge; it emits all variants, and the analyzer shares validator runs across variants that produce the same HTML (monorepo.md §6.2, analyzer.md §5.1) | To show, on hover, evidence of which decisions caused a problem. Merging in core would lose that information. The runtime cost is recovered by sharing runs based on the HTML content hash |
| 2 | Sharing `v-for` cardinality and correlating it with length predicates | `for-count` was local to each FOR node, and was not correlated with other FOR nodes on the same collection or with `items.length` conditions | Collections with the same symbol / access path identity share one `collection-cardinality` decision, and this decision is correlated with `length` predicates that can be interpreted. Filter results and function results are never shared (core.md §4.5) | This prevents contradictory variants (for example, a branch that renders even though the collection has 0 items) in the common pattern `v-if="items.length > 0"` wrapping a `v-for`. Because sharing is limited to the same identity, this does not raise concerns about variant count |
| 3 | Provenance | None (rejected in the Rev. 5 review for lack of a consumer, and still not adopted in Rev. 8) | `MappingEntry.provenance` (core.md §5.4, §7) | A concrete consumer now exists: the analyzer's sentinel / synthetic value normalization (analyzer.md §7) |
| 4 | Sentinel (`dummy-string`) diagnostics | Show the validator's raw error as-is (a bridge-specific diagnostic was rejected because it would fall outside the linter's report) | The analyzer rewrites the message into a bridge-specific one, and keeps the original message as evidence (analyzer.md §7.1) | In the LSP, the rewritten diagnostic still appears in the same diagnostic stream and at the same source position, so it still fits into the developer's normal workflow. On top of that, this avoids the confusion of `dummy-string` looking like it actually exists in the source |
| 5 | Delivery form | A separate adapter library per linter (for example, vue-html-bridge-markuplint), each implementing its own reverse mapping | An LSP language server as the main delivery form. Validators are adapters that plug into a shared SPI (validator-api), and the bridge side runs them. A batch-analysis CLI is out of scope for the initial release (monorepo.md §1, §2.2) | The product goal is now immediate feedback while editing. The analyzer's API does not depend on the LSP, so a CLI can be added later as another consumer of the analyzer |
| 6 | Warning threshold for variant count | A fixed internal threshold of 10,000, not exposed as a user option | A `warnVariantCount` option (default 256). It still only warns and never cuts off generation (core.md §2.1) | In the LSP, the warning is shown continuously while editing, so a way to tune it per project size is needed in settings |
| 7 | Detecting Web Components | `isCustomElement?: (tag: string) => boolean` | `customElements?: readonly string[]` (tag names or globs. core.md §2.1) | A function cannot be normalized into a cache key, and cannot be passed through JSON-based LSP settings, so this was changed to a declarative form |

## Specs restored from the old design

The following decisions were dropped during the move to a monorepo. This was a carry-over gap, not an intentional change, so they have been restored into core.md.

- Input contract: handling of `<template lang>`, `<template src>`, `<script src>`, `<script lang="ts">` without `<script setup>`, plain `<script>`, `lang="tsx"`, and custom delimiters (core.md §1)
- Web Components: `GenerateOptions.customElements` (the declarative form of the old `isCustomElement`. core.md §2.1, §5.2)
- The `is` attribute on a native element is emitted as the real attribute of a customized built-in element; the `vue:` prefix is treated as a component (core.md §5.1)
- Vue-specific attributes that are not emitted: `key`, `ref`, `true-value`, `false-value` (core.md §5.3)
- Handling of `v-bind` modifiers: `.prop` / the `.` shorthand are not emitted, `.camel` is camelized, `.attr` is emitted normally, and a shorthand with the same name is treated as a normal `v-bind` (core.md §5.3)
- `v-model`: does not emit `selected` on a `<select>`'s option. When it conflicts with a static `value` / `checked`, `v-model` takes priority and a diagnostic is reported (core.md §5.3)
- The Decision Model's expression evaluation rules: the list of supported operators, the predicate decision, the unknown fallback, and deduplication of diagnostics for non-evaluable expressions (ported from Rev. 8 §9.4 into core.md §4.6)
- The limitation that newlines inside text content (for example, inside `<pre>`) are lost by one-line serialization (core.md §11)
