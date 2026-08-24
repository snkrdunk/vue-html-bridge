# `@vue-html-bridge/cli`

A one-shot command-line client for [vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge):
runs the same analysis as the language server, for CI pipelines,
pre-commit hooks, and ad-hoc terminal use. It accepts the same settings
schema as the editor (`@vue-html-bridge/settings`) as command-line flags,
and loads adapters through the same `@vue-html-bridge/adapter-loader` — the
CLI and the language server are guaranteed to report the same diagnostics
for the same file under the same resolved settings and trust policy.

## Installation

```sh
npm install --global @vue-html-bridge/cli
```

or as a project `devDependency` invoked via `npx vue-html-bridge` / a
package-manager script.

## Usage

```sh
vue-html-bridge src/components
```

```text
src/components/Menu.vue:6:27 error no-refer-to-non-existent-id
  Missing "missing" ID [markuplint]
3 files analyzed: 1 error, 0 warnings, 0 infos, 0 hints
```

With no positional arguments, the `include` setting (default `**/*.vue`,
relative to `--workspace-root`, default the current directory) is used
instead. Exit code `0` means no diagnostic reached the `--fail-on` threshold
(default `error`); `1` means one did; `2` means a run-level problem occurred
(a bad argument, a fatal settings issue, a file that couldn't be read, an
adapter that failed to load) — see below. `130`/`143` on `SIGINT`/`SIGTERM`.

Machine-readable output:

```sh
vue-html-bridge --format ndjson src/components
```

emits one self-contained JSON object per line (`meta`, then one `file` line
per analyzed file as it completes, then a `summary` line) — safe to pipe
into another process and to parse incrementally; see
[`docs/design/packages/cli.md`](../../docs/design/packages/cli.md) §7.2 for
the full record shapes and their versioning contract (`CliNdjsonRecord`,
also exported from this package's own public API for TypeScript consumers).

Run `vue-html-bridge --help` for the full flag reference — every field of
the shared settings schema that's meaningful outside an editor session has a
corresponding flag, listed in cli.md §4.2.

## Trust

Running the CLI in a repository is treated the same as running any other
linter's CLI there: **trusted by default** — it reads the workspace's
validator config, including JS config and plugins, exactly as a trusted
editor session would. Pass `--untrusted` for CI jobs analyzing untrusted
contributions: it forces `externalAdapters` off and the built-in Markuplint
adapter to its bundled, safe default config, while leaving every
host-neutral setting (`include`/`exclude`, `maxConcurrency`, output format,
`--fail-on`) unaffected.

## Configuration

The same `.vue-html-bridge.json` / `package.json#vueHtmlBridge` file the
language server discovers is used here too — flags and `--config <path>`
simply layer on top with the same precedence and validation rules as
`workspace/configuration` does for the editor
(`@vue-html-bridge/settings`'s `resolveSettings`, applied identically by
both hosts). Unlike the editor, an **`error`-severity settings issue is
fatal** here (exit `2`, before any analysis runs) rather than falling back —
CI must fail loudly on misconfiguration, not analyze with silently-wrong
settings.

See [`docs/design/packages/cli.md`](../../docs/design/packages/cli.md) for
the complete flag surface, the NDJSON contract, and the run-outcome/exit-code
model.
