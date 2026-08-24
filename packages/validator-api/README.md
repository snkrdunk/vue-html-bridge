# `@vue-html-bridge/validator-api`

The stable Service Provider Interface (SPI) that connects any HTML validator
to [vue-html-bridge](https://github.com/vue-html-bridge/vue-html-bridge).
Implement `HtmlValidatorAdapter` against this package and your validator can
run inside the vue-html-bridge language server and CLI — no changes to
either host are needed.

This package has no implementation of its own: it is types plus a small
amount of runtime shape-checking. It has no dependency on any other
`vue-html-bridge` package, so you can build and test an adapter against it
in isolation.

## Installation

```sh
npm install --save-peer @vue-html-bridge/validator-api
npm install --save-dev @vue-html-bridge/adapter-testkit
```

Declare it as a **peer dependency**, with a semver range matching the
`apiVersion` major you target (see [Versioning](#versioning) below) — a
host may hold a different minor/patch version than the one you developed
against, and peer dependencies are how npm surfaces a real incompatibility
instead of silently installing two copies.

## Minimal example

```ts
import type { HtmlValidatorAdapter } from "@vue-html-bridge/validator-api";

interface ExampleSettings {
  // whatever your validator needs from the user's settings
}

export const exampleAdapter: HtmlValidatorAdapter<ExampleSettings> = {
  apiVersion: 1,
  id: "example",
  displayName: "Example HTML Validator",
  capabilities: {
    execution: "in-process",
    supportsCancellation: true,
    supportsConfigFiles: false,
    fragmentHandling: "native",
    maxConcurrentValidations: 4,
  },

  async createSession({ settings, logger }) {
    const engine = createExampleEngine(settings);

    return {
      async validate(request, signal) {
        signal.throwIfAborted();
        try {
          const raw = await engine.check(request.html, signal);
          return {
            diagnostics: raw.issues.map((issue) => ({
              ruleId: issue.rule,
              severity: issue.warning ? "warning" : "error",
              message: issue.message,
              range: toUtf16Range(request.html, issue.location),
            })),
            failures: [],
          };
        } catch (error) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          logger.error("Validator execution failed");
          return {
            diagnostics: [],
            failures: [
              { code: "execution-error", message: String(error), recoverable: true },
            ],
          };
        }
      },
      async dispose() {
        await engine.close();
      },
    };
  },
};
```

A validator receives a plain HTML fragment (`request.html`) with no Vue
directives — vue-html-bridge has already resolved everything Vue-specific
into concrete HTML before your adapter ever sees it. If your validator can
only check a full document, set `capabilities.fragmentHandling: "wrapped"`,
wrap the fragment yourself, and translate both diagnostics and ranges back
to `request.html` coordinates before returning — never return a diagnostic
that comes only from your own wrapper.

See the full SPI surface — `HtmlValidatorAdapter`, `AdapterCapabilities`,
`ValidatorSession`, `ValidateHtmlRequest`/`Result`, `GeneratedDiagnostic`,
`AdapterFailure`, `ConfigWatchTarget` — in [`src/index.ts`](./src/index.ts);
every exported type has a doc comment.

## Contract, not just types

TypeScript structural typing alone does not guarantee your adapter behaves
correctly at every boundary this SPI cares about: UTF-16 range semantics
across emoji and multi-line HTML, cancellation, failure vs. diagnostic
separation, determinism, JSON-serializability. `@vue-html-bridge/adapter-testkit`
provides a runnable contract suite that checks all of it against your real
implementation:

```ts
import { defineVitestAdapterContract } from "@vue-html-bridge/adapter-testkit/vitest";
import { exampleAdapter } from "./adapter.js";

defineVitestAdapterContract("example", {
  adapter: exampleAdapter,
  workspaceRoot: fixtureRoot,
  settings: {},
  validHtml: "<p>text</p>",
  invalidHtml: {
    html: "<img>", // missing alt, or whatever your validator flags
    expectedSubstring: "img",
  },
});
```

An adapter that passes the contract suite is guaranteed to work correctly
with both vue-html-bridge hosts (language server and CLI) without either
one being modified.

## Runtime validation

`checkHtmlValidatorAdapter` performs the minimal runtime shape check a host
uses before trusting an unknown module's default export as a real adapter
(the `apiVersion` check plus a structural check of `id`/`displayName`/
`capabilities`/`createSession`). It does not resolve package names or
perform dynamic imports — that is the host's own job
(`@vue-html-bridge/adapter-loader`), not this package's.

## Versioning

- **Compatibility is checked at runtime via `apiVersion`**, not by trusting
  TypeScript types alone — a host verifies `adapter.apiVersion === 1`
  (`VALIDATOR_API_VERSION`) before using an adapter at all.
- **Adding an optional field to an existing SPI type is a minor version
  bump.** Changing a required field, its meaning, or removing anything is a
  **major** bump, and always comes with a new `apiVersion` value — a host
  can then support both the old and new `apiVersion` at once during a
  transition period, so existing adapters do not break the moment a host
  upgrades.
- **Declare `@vue-html-bridge/validator-api` as a peer dependency**, with a
  semver range matching the `apiVersion` major you built against (e.g.
  `"^1.0.0"` for `apiVersion: 1`). This lets npm flag a real incompatibility
  at install time instead of silently running against a version your
  adapter was never tested with.
- **`ConfigWatchTarget` / `ValidatorSession.getConfigWatchTargets()` is
  optional.** Only implement it if your validator resolves local
  configuration files a host should watch for changes; an adapter whose
  configuration is entirely remote or in-memory can omit it entirely — a
  host must never assume it exists.
- Every adapter is expected to pass `@vue-html-bridge/adapter-testkit`'s
  contract suite before being considered compatible — the testkit's own
  major version tracks this package's major version.
