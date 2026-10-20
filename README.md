# vue-html-bridge

`vue-html-bridge` validates Vue 3 Single-File Component (`.vue`) `<template>` blocks as static HTML and reports problems at their locations in the original Vue files. Use it as a Language Server in an editor or as a CLI in CI and from the terminal.

## The problem

Standard HTML validators do not understand Vue template syntax. And for templates with `v-if` or dynamic attributes, validating a single HTML translation would miss other outputs the component can produce.

This makes it harder to catch HTML issues—such as incorrect accessibility attributes, element usage, and ID references—while developing Vue components.

## How it works

Without running the Vue app, vue-html-bridge uses the template and any type information it can resolve to generate the possible static HTML variants. It validates each variant with Markuplint, then maps diagnostics back to line and column locations in the original `.vue` file. When the same issue appears in multiple variants, it is reported once as a source-level problem.

```text
Vue SFC → static HTML variats → Markuplint → diagnostics on .vue file
```

The Language Server and CLI share the same analysis and configuration, so they report the same diagnostics for the same file, settings, and trust policy. Markuplint is the currently built-in validator.

### Current scope

- Validates Vue 3 SFC `<template>` blocks as static HTML.
- Analyzes variants produced by `v-if`, `v-for`, dynamic attributes, and related syntax.
- Maps diagnostic locations back to the original `.vue` file.
- Uses Markuplint configuration and rules.

The runtime DOM, expanded child component templates, and HTML inserted by `v-html` are outside the validation scope. The Vue app does not need to be started.

## Installation

Add the CLI to your project:

```sh
npm install --save-dev @vue-html-bridge/cli
```

Or use pnpm or yarn:

```sh
pnpm add --save-dev @vue-html-bridge/cli
yarn add --dev @vue-html-bridge/cli
```

To see diagnostics in an editor, install `@vue-html-bridge/language-server` separately and configure your LSP client to launch it. This repository does not provide editor-specific extensions.

## Usage

### CLI

Validate the project's Vue files:

```sh
npx vue-html-bridge
```

By default, the CLI checks `*.vue` files under the current directory. When you specify files, directories, or globs, those replace the `include` setting.

```sh
npx vue-html-bridge src/components
npx vue-html-bridge src/App.vue 'src/pages/**/*.vue'
```

Example text output:

```text
src/components/Menu.vue:6:27 error no-refer-to-non-existent-id
  Missing "missing" ID [markuplint]
3 files analyzed: 1 error, 0 warnings, 0 infos, 0 hints
```

For machine processing, use NDJSON (one JSON object per line):

```sh
npx vue-html-bridge --format ndjson src/components
```

Exit codes: `0` means no diagnostic reached the selected threshold; `1` means at least one did; `2` indicates a run problem, such as invalid settings, input, or an adapter error. By default, the CLI displays errors and warnings. Add `--verbose` to include info and hint diagnostics. The default `--fail-on` threshold is `error`.

### Configuration

Put settings in `.vue-html-bridge.json` at the workspace root or in the `vueHtmlBridge` field of `package.json`. To select a file explicitly, use `--config <path>`.

```json
{
  "$schema": "./node_modules/@vue-html-bridge/settings/schema.json",
  "include": ["src/**/*.vue"],
  "exclude": ["**/node_modules/**", "**/generated/**"],
  "validators": [
    {
      "adapter": "markuplint",
      "enabled": true
    }
  ]
}
```

Settings are applied in this order: CLI flags, `--config`, workspace settings, then defaults. Without a settings file, the CLI defaults to `**/*.vue` and enables the built-in Markuplint adapter. See [`docs/design/packages/cli.md`](docs/design/packages/cli.md) and [`packages/settings/schema.json`](packages/settings/schema.json) for the full settings reference.

Common options:

```sh
npx vue-html-bridge --help
npx vue-html-bridge --config ./config/vue-html-bridge.json src
npx vue-html-bridge --fail-on warning src
npx vue-html-bridge --format ndjson --verbose src
npx vue-html-bridge --emit-html ./tmp/vue-html-bridge src
npx vue-html-bridge --untrusted src
```

`--emit-html` writes generated HTML variants and mapping information for inspection. The CLI runs once per invocation; it does not support watch mode or stdin input.

### Trust policy

By default, the CLI treats the workspace as trusted and uses its Markuplint configuration and explicitly configured external adapters. When checking untrusted contributions in CI, pass `--untrusted`. This disables external adapters and runs Markuplint with its bundled safe defaults.

## Development

This repository is a pnpm workspace. It requires Node.js 22 or later and pnpm.

```sh
pnpm install
pnpm build
pnpm test
```

## Package and design documentation

- [CLI の利用方法とオプション](packages/cli/README.md) (How to use CLI and its options)
- [全体設計](docs/design/monorepo.md) (overall architecture)
- [設計資料一覧](docs/design/README.md) (list of design docs)
