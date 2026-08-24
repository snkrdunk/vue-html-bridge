# `@vue-html-bridge/analyzer`

The orchestration layer of [vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge):
runs [`vue-html-bridge`](../core)'s variant generation, dispatches each
variant to every configured `@vue-html-bridge/validator-api` adapter with
bounded concurrency, reverse-maps every diagnostic back to the source
`.vue` file, aggregates duplicate findings across variants, and caches
results. Both hosts — the language server and the CLI — consume this
package and nothing lower-level; neither one calls core or a validator
directly.

## Installation

```sh
npm install @vue-html-bridge/analyzer
```

You'll also need at least one validator adapter — the bundled default is
`@vue-html-bridge/adapter-markuplint`.

## Minimal example

```ts
import { createWorkspaceAnalyzer, createTypeAnalysisContext } from "@vue-html-bridge/analyzer";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";

const analyzer = await createWorkspaceAnalyzer({
  workspaceRoot: "/workspace",
  adapters: [{ adapter: markuplintAdapter, settings: {}, enabled: true }],
  typeContext: createTypeAnalysisContext(),
});

const result = await analyzer.analyze({
  uri: "file:///workspace/src/components/Menu.vue",
  filename: "/workspace/src/components/Menu.vue",
  source: await readFile("/workspace/src/components/Menu.vue", "utf8"),
  signal: new AbortController().signal,
});

for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.severity, diagnostic.code, diagnostic.message);
}

await analyzer.dispose();
```

`result.diagnostics` (`SourceDiagnostic[]`) always carries ranges in the
*original* `.vue` file's UTF-16 offsets — generated-HTML coordinates never
leak past this package's boundary.

## Reconfiguring a live session

`analyzer.reconfigure({ adapters, generateOptions, maxConcurrency, invalidateAdapters })`
lets a long-lived host (the language server) react to a settings or
config-file change without recreating the whole analyzer: adapter sessions
are only recreated when their settings actually changed (or when explicitly
named in `invalidateAdapters`, e.g. after a watched config file changes on
disk); everything else — the generation cache, other adapters' sessions —
survives untouched.

See [`docs/design/packages/analyzer.md`](../../docs/design/packages/analyzer.md)
for the full pipeline design, caching strategy, and diagnostic-aggregation
rules.
