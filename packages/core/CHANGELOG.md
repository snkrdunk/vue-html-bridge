# vue-html-bridge

## 0.3.0

### Minor Changes

- 38d4eb2: Evaluate non-empty `<slot>` fallback content as real template content instead of silently dropping it; empty slots are still ignored.

## 0.2.1

### Patch Changes

- b0f1c24: Downgrade the `expression-not-symbolically-evaluable` diagnostic from `warning` to `hint` severity. This diagnostic fires once per template expression core cannot evaluate statically (e.g. a `v-if`/`v-show` condition calling a method), so on real components it is often the majority of a run's diagnostics and drowned out `warning`-and-above findings that actually need attention. It remains reported — just at the lowest severity, below `error`/`warning`/`info`.

## 0.2.0

### Minor Changes

- d732894: Add custom-directive attribute value modeling (ADR-0010). A new `customDirectives` setting (and core `GenerateOptions` field) declares which attributes a custom directive sets and how to derive each value from its bound expression — a literal string constant, or `$value` optionally followed by dotted property segments — closing the `required-attr` false-positive class for attribute-setting directives like `v-src`. The analyzer's generation-cache key now includes `customDirectives`, so two runs differing only in declared mappings can no longer collide on one cache entry.

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
