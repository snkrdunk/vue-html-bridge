# `vue-html-bridge`

The core of [vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge):
parses a Vue 3 Single-File Component template and generates one or more
concrete, static HTML variants — one per meaningfully distinct combination of
`v-if`/`v-else`/`v-for`/dynamic-binding outcomes — with source mapping back
to the original `.vue` file. Any plain HTML validator can then check those
variants without knowing anything about Vue.

This package has no knowledge of any particular HTML validator, the language
server, or the CLI. It is a pure "Vue template → static HTML" engine; the
validation pipeline that consumes its output lives in
[`@vue-html-bridge/analyzer`](../analyzer).

## Installation

```sh
npm install vue-html-bridge
```

Most consumers should not need this package directly — reach for
`@vue-html-bridge/analyzer`'s `createWorkspaceAnalyzer`/`analyze`, which
orchestrates generation, validation, and reverse-mapping together. Import
this package directly only if you are building a new host that needs
generation without validation.

## Minimal example

```ts
import { generateVariants, createTypeAnalysisContext } from "vue-html-bridge";

const result = await generateVariants({
  filename: "/workspace/src/components/Menu.vue",
  source: await readFile("/workspace/src/components/Menu.vue", "utf8"),
  typeContext: createTypeAnalysisContext(),
  signal: new AbortController().signal,
});

for (const variant of result.variants) {
  console.log(variant.id, variant.html);
}
```

`createTypeAnalysisContext()` gives the generator a thin, caller-owned
filesystem/TypeScript-project abstraction (ADR-0002) — one instance is meant
to be created once per workspace root and reused across calls, not recreated
per file.

## What it does not do

- Run any HTML validator (`@vue-html-bridge/adapter-markuplint` and other
  adapters implement `@vue-html-bridge/validator-api` for that).
- Reverse-map validator diagnostics back to source coordinates on its own —
  it exposes `findSourceOrigins` and `MappingEntry`s for a caller to do that;
  `@vue-html-bridge/analyzer` is the caller that actually does it.
- Cache anything across calls, or know about LSP/CLI concerns.

See [`docs/design/packages/core.md`](../../docs/design/packages/core.md) for
the full design: variant-generation semantics, the Decision Model, and the
source-mapping contract.
