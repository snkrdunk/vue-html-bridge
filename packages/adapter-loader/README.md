# `@vue-html-bridge/adapter-loader`

The host-neutral, single implementation of validator-adapter loading and
trust gating for [vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge),
shared by the language server and the CLI. Which adapters get loaded, under
which trust conditions, and how load failures are classified is
security-sensitive behavior — this package owns it once so the two hosts
cannot drift on what workspace code is allowed to run.

## Installation

```sh
npm install @vue-html-bridge/adapter-loader
```

You will not normally need this package unless you're building a new host
for vue-html-bridge; the language server and CLI already use it internally.

## Usage

```ts
import { loadConfiguredAdapters, nodeModuleResolver } from "@vue-html-bridge/adapter-loader";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";

const { adapters, failures } = await loadConfiguredAdapters({
  validators: resolvedSettings.validators, // from @vue-html-bridge/settings
  workspaceRoot: "/workspace",
  trust: { workspaceTrusted: true, externalAdapters: "trusted-workspace-only" },
  builtins: new Map([["markuplint", markuplintAdapter]]),
  moduleResolver: nodeModuleResolver, // the default; inject your own for tests or PnP
});

// adapters: readonly LoadedAdapter[] — ready for createWorkspaceAnalyzer
// failures: readonly AdapterLoadFailure[] — structured, deduplicated by `dedupeKey`,
//           one per bad validators[] entry; loading the rest is never blocked
```

For each `validators[]` entry: a `builtins` match is used directly (bypassing
the external gates, but not the `apiVersion` check). Otherwise the entry key
is treated as an npm package specifier and must pass every gate in order —
explicit in settings, `externalAdapters === "trusted-workspace-only"`,
`workspaceTrusted === true`, a plain package specifier (no paths, URLs, or
data URIs), resolves through the workspace's own module resolution, and its
export passes `@vue-html-bridge/validator-api`'s runtime shape check with a
matching `apiVersion`. Loading is a **trust boundary, not a security
boundary**: nothing here sandboxes the code an external adapter runs (see
ADR-0008) — the gates decide *whether* to run it, not what it's allowed to
do once running.

## Testing your own host integration

`ADAPTER_LOADER_CONTRACT_SCENARIOS`, `ADAPTER_LOADER_CONTRACT_BUILTINS`, and
`adapterLoaderContractModuleResolver` are exported specifically so a new
host can replay this package's own gate-matrix contract against its real
wiring (see `packages/language-server/src/adapters/loading.test.ts` and
`packages/cli/src/adapters.test.ts` for two real examples) — proving your
host applies the exact same gating without writing a second implementation
of "the same" rules.

See [`docs/design/packages/adapter-loader.md`](../../docs/design/packages/adapter-loader.md)
for the full loading rules, failure taxonomy, and host responsibilities.
