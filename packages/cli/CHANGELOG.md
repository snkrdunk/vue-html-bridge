# @vue-html-bridge/cli

## 0.3.1

### Patch Changes

- @vue-html-bridge/analyzer@0.2.1
  - @vue-html-bridge/settings@0.2.0

## 0.3.0

### Minor Changes

- d6a519d: Add a `--verbose` flag and show info and hint diagnostics only when it is set.

## 0.2.0

### Minor Changes

- 3b99009: Add `--emit-html <dir>` CLI flag for debugging generated HTML. When passed, writes each generated HTML variant (using the existing content-hash-keyed virtual-filename convention) plus a JSON sidecar correlating it back to the source-level decisions and mapping that produced it. Opt-in only; no behavior change when the flag is omitted. See ADR-0011 for the design rationale.

### Patch Changes

- Updated dependencies [3b99009]
  - @vue-html-bridge/analyzer@0.2.0

## 0.1.2

### Patch Changes

- @vue-html-bridge/analyzer@0.1.2
  - @vue-html-bridge/settings@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [d732894]
  - @vue-html-bridge/settings@0.2.0
  - @vue-html-bridge/analyzer@0.1.1
  - @vue-html-bridge/adapter-loader@0.1.0

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
  - @vue-html-bridge/validator-api@0.1.0
  - @vue-html-bridge/analyzer@0.1.0
  - @vue-html-bridge/adapter-markuplint@0.1.0
  - @vue-html-bridge/settings@0.1.0
  - @vue-html-bridge/adapter-loader@0.1.0
