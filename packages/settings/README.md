# `@vue-html-bridge/settings`

The single source of truth for [vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge)'s
user-facing configuration, shared by both hosts: the settings schema
(input and resolved forms), its defaults, layer validation/merging,
decomposition into the options each downstream package consumes, and
discovery/loading of `.vue-html-bridge.json` / `package.json#vueHtmlBridge`.
Defining this once is what guarantees the language server (via
`workspace/configuration` plus workspace files) and the CLI (via flags plus
the same workspace files) cannot drift on what a given setting means.

This package has no runtime dependency on any other `vue-html-bridge`
package, so any future host can use it without pulling in core, the
analyzer, or an adapter.

## Installation

```sh
npm install @vue-html-bridge/settings
```

## Usage

```ts
import {
  resolveSettings,
  decomposeSettings,
  loadWorkspaceSettingsFile,
  createNodeFileSystem,
} from "@vue-html-bridge/settings";

const discovered = await loadWorkspaceSettingsFile(
  "/workspace",
  createNodeFileSystem(),
);

const { settings, issues } = resolveSettings([discovered.settings]);
// issues: readonly SettingsIssue[] — unknown fields warn and are dropped;
// invalid values are errors, pinned to the package default.

const { generateOptions, analyzer, validators, host } = decomposeSettings(settings);
// generateOptions  -> core's GenerateOptions (warnVariantCount, customElements)
// analyzer         -> maxConcurrency
// validators       -> validators[] ready for @vue-html-bridge/adapter-loader
// host             -> enabled/include/exclude/validateOn*/debounceMs/externalAdapters,
//                      each host's own scheduling and trust logic
```

`resolveSettings` takes an ordered stack of raw layers (lowest precedence
first) — a discovered file, then `workspace/configuration` for the language
server, or CLI flags for the CLI — and applies one normative resolution:
each layer is validated independently, then layers merge with full array
replacement. Both hosts call the exact same function; neither redefines
this logic.

## The published JSON Schema

`schema.json`, generated from this package's own types
(`generate-schema.mjs` → `generateSettingsJsonSchema`/
`serializeSettingsJsonSchema`), is published as
`@vue-html-bridge/settings/schema.json` so editors and other tools can
validate `.vue-html-bridge.json` without depending on this package's
JavaScript at all:

```json
{ "$schema": "./node_modules/@vue-html-bridge/settings/schema.json" }
```

See [`docs/design/packages/settings.md`](../../docs/design/packages/settings.md)
for the full schema reference, the defaults table, and resolution
semantics.
