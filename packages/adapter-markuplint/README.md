# `@vue-html-bridge/adapter-markuplint`

The built-in, default HTML validator adapter for
[vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge),
implementing `@vue-html-bridge/validator-api` on top of
[Markuplint](https://markuplint.dev/). Both hosts (language server and CLI)
load this adapter automatically unless a workspace's settings explicitly
disable or replace it.

You normally don't import this package directly — the language server and
CLI already depend on it and configure it from the shared settings schema
(`validators[].adapter: "markuplint"`, `validators[].settings`, typed here as
`MarkuplintAdapterSettings`). It's a useful reference implementation if
you're writing a new adapter against `@vue-html-bridge/validator-api`, and
its own test suite (`src/index.test.ts`) is a good example of exercising the
`@vue-html-bridge/adapter-testkit` contract suite against a real validator.

## Configuration

`MarkuplintAdapterSettings` (settable per-workspace via
`validators[].settings` in `.vue-html-bridge.json`, or via the CLI's
`--validator-setting markuplint.<path>=<value>`):

| Field | Meaning |
| --- | --- |
| `configFile` | Explicit Markuplint config path, resolved from the workspace root. Takes priority over auto-discovery. |
| `searchConfig` | When `configFile` isn't set, search upward from each source file for the nearest Markuplint config (cosmiconfig conventions). Default `true`. |
| `profile` | `"generated-html"` (default) applies an overlay that disables source-formatting rules that don't make sense against bridge-generated HTML, while keeping semantic rules active. `"as-configured"` applies the discovered/explicit config strictly, with no overlay. |

In an untrusted workspace, both hosts force `searchConfig: false` and no
`configFile` regardless of the resolved settings — this adapter never reads
workspace JS config or plugins unless the workspace is explicitly trusted
(language-server.md §4.2, cli.md §5).

## Config discovery and watching

This adapter resolves the nearest Markuplint config per source file's
directory (not the workspace root), supports the full `extends`/plugin
chain, and reports every config file it actually depends on through
`ValidatorSession.getConfigWatchTargets()` — both hosts use this to know
which files on disk should trigger re-validation when they change, without
needing any Markuplint-specific knowledge themselves.

See [`docs/design/packages/adapter-markuplint.md`](../../docs/design/packages/adapter-markuplint.md)
for the full design: config resolution and merge priority, the
generated-HTML rule overlay, coordinate conversion, and the failure
classification table.
