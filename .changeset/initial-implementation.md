---
"vue-html-bridge": minor
"@vue-html-bridge/validator-api": minor
"@vue-html-bridge/analyzer": minor
"@vue-html-bridge/adapter-markuplint": minor
"@vue-html-bridge/adapter-testkit": minor
"@vue-html-bridge/settings": minor
"@vue-html-bridge/adapter-loader": minor
"@vue-html-bridge/language-server": minor
"@vue-html-bridge/cli": minor
---

Initial implementation of the vue-html-bridge toolchain: variant generation
and source mapping for Vue 3 SFC templates (`vue-html-bridge`), the
validator adapter SPI and its contract testkit
(`@vue-html-bridge/validator-api`, `@vue-html-bridge/adapter-testkit`), the
analysis pipeline (`@vue-html-bridge/analyzer`), the built-in Markuplint
adapter (`@vue-html-bridge/adapter-markuplint`), shared settings and
external-adapter loading/trust gating (`@vue-html-bridge/settings`,
`@vue-html-bridge/adapter-loader`), and both hosts
(`@vue-html-bridge/language-server`, `@vue-html-bridge/cli`).
