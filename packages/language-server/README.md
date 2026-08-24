# `@vue-html-bridge/language-server`

A standalone Language Server Protocol server for
[vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge):
publishes diagnostics and hover information for `.vue` files, backed by
`@vue-html-bridge/analyzer` and the built-in `@vue-html-bridge/adapter-markuplint`
adapter (plus any external adapters your workspace's settings enable).

This package ships standalone — a stdio binary plus a library entry point —
with no bundled editor client in this release (ADR-0009). Point any
LSP-capable editor's generic "custom language server" configuration at the
binary below.

## Installation

```sh
npm install --global @vue-html-bridge/language-server
```

or as a project dependency your editor extension launches directly.

## Running it

```sh
vue-html-bridge-language-server --stdio
```

The server speaks LSP over stdio. It negotiates UTF-16 position encoding by
default (falling back to whatever the client declares if UTF-16 isn't
offered), supports incremental text sync, and publishes diagnostics on
`didOpen`/`didChange`/`didSave` with a `200 ms` debounce for `didChange`.

## Configuration

Settings are the shared schema from `@vue-html-bridge/settings` — the same
fields the CLI accepts as flags — resolved from, in precedence order:
`workspace/configuration`, the discovered `.vue-html-bridge.json` /
`package.json#vueHtmlBridge`, then package defaults. Pass
`initializationOptions: { workspaceTrusted, settings }` at `initialize` to
seed trust and a settings fallback for clients that don't support
`workspace/configuration`.

**Trust** (language-server.md §4.2): a workspace must be explicitly marked
trusted (via `initializationOptions.workspaceTrusted` or settings) before the
built-in Markuplint adapter will read the workspace's own config/plugins, or
before any external adapter loads at all. An untrusted workspace still
analyzes with the bundled, safe default Markuplint configuration — analysis
never stops, only workspace-code execution is gated.

**Multi-root**: each workspace folder gets its own settings, adapter
sessions, and analysis cache; a file outside every folder gets a restricted,
untrusted, per-directory session of its own.

## Programmatic usage

```ts
import { startLanguageServer } from "@vue-html-bridge/language-server";
import { createConnection } from "vscode-languageserver/node";

const handle = startLanguageServer({
  connection: createConnection(process.stdin, process.stdout),
});
// handle.dispose() on shutdown
```

See [`docs/design/packages/language-server.md`](../../docs/design/packages/language-server.md)
for the full protocol surface, settings precedence, and trust model.
