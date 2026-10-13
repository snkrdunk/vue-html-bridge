# @vue-html-bridge/analyzer

## 0.2.3

### Patch Changes

- 807d379: Fix `approximateGenerateResultBytes` undercounting a cached generation result's size: it now accounts for each variant's `decisions` (previously dropped entirely) and for a mapping entry's nested `provenance`/`sourceRange` payload (previously flattened to a fixed 64-byte guess, ignoring an arbitrarily long `sourceRange.filename`). `maxApproximateBytes` now correctly bounds real cache memory for files with many variants or long paths.
- eb55ee7: Base the severity of `vue-html-bridge/non-finite-attribute-value` and `vue-html-bridge/unresolved-expression-value` on why the value could not be resolved, instead of inheriting the wrapped validator rule's severity (previously often `error`, even though these diagnostics report an analysis limitation rather than a confirmed markup violation). `non-finite-type` (the bound type is too broad to narrow, e.g. `pressed: string`) is now `warning`; `unresolved-expression` (core's evaluator couldn't evaluate the expression at all, e.g. `!item.isSold`) is now `info`.

## 0.2.2

### Patch Changes

- Updated dependencies [f27806d]
  - vue-html-bridge@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [38d4eb2]
  - vue-html-bridge@0.3.0

## 0.2.0

### Minor Changes

- 3b99009: Add `--emit-html <dir>` CLI flag for debugging generated HTML. When passed, writes each generated HTML variant (using the existing content-hash-keyed virtual-filename convention) plus a JSON sidecar correlating it back to the source-level decisions and mapping that produced it. Opt-in only; no behavior change when the flag is omitted. See ADR-0011 for the design rationale.

## 0.1.2

### Patch Changes

- Updated dependencies [b0f1c24]
  - vue-html-bridge@0.2.1

## 0.1.1

### Patch Changes

- d732894: Add custom-directive attribute value modeling (ADR-0010). A new `customDirectives` setting (and core `GenerateOptions` field) declares which attributes a custom directive sets and how to derive each value from its bound expression — a literal string constant, or `$value` optionally followed by dotted property segments — closing the `required-attr` false-positive class for attribute-setting directives like `v-src`. The analyzer's generation-cache key now includes `customDirectives`, so two runs differing only in declared mappings can no longer collide on one cache entry.
- Updated dependencies [d732894]
  - vue-html-bridge@0.2.0

## 0.1.0

### Minor Changes

- 9ce88e1: Initial implementation of the vue-html-bridge toolchain: variant generation
  and source mapping for Vue 3 SFC templates (`vue-html-bridge`), the
  validator adapter SPI and its contract testkit
  (`@vue-html-bridge/validator-api`, `@vue-html-bridge/adapter-testkit`), the
  analysis pipeline (`@vue-html-bridge/analyzer`), the built-in Markuplint
  adapter (`@vue-html-bridge/adapter-markuplint`), shared settings and
  external-adapter loading/trust gating (`@vue-html-bridge/settings`,
  `@vue-html-bridge/adapter-loader`), and both hosts
  (`@vue-html-bridge/language-server`, `@vue-html-bridge/cli`).

### Patch Changes

- Updated dependencies [9ce88e1]
  - vue-html-bridge@0.1.0
  - @vue-html-bridge/validator-api@0.1.0
