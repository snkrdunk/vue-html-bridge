# `@vue-html-bridge/adapter-testkit`

A `devDependency`-only package that verifies whether a
[`@vue-html-bridge/validator-api`](../validator-api) adapter meets the common
contract: UTF-16 ranges, failure/diagnostic separation, cancellation, session
lifecycle, concurrency, JSON-serializability, and config watch targets.

It exists so that a second or third validator adapter can be added without
changing the analyzer or the language server — the contract suite, not just
TypeScript's structural typing, is what proves an adapter behaves correctly
at every boundary the SPI cares about.

## Exports

Split across three entry points so the framework-neutral core never pulls in
a test-runner dependency:

- `@vue-html-bridge/adapter-testkit` — `createAdapterContractCases`, the
  fixture types, and the educational `createNoBlinkAdapter` sample. No
  dependency on Vitest or any other test framework.
- `@vue-html-bridge/adapter-testkit/vitest` — `defineVitestAdapterContract`,
  a thin Vitest binding over the same cases.
- `@vue-html-bridge/adapter-testkit/fake` — `createFakeAdapter`, a
  controllable in-memory adapter for analyzer/language-server unit tests
  (queued results, call capture, abort barriers). Only ever imported from
  test files.

See [`docs/design/packages/adapter-testkit.md`](../../docs/design/packages/adapter-testkit.md)
for the full contract-case catalogue (§3) and self-test list (§6/§8).

## Versioning

- **The testkit's major version tracks `@vue-html-bridge/validator-api`'s
  major version.** A `validator-api` major bump (a required-field change, or
  a new `apiVersion`) is always accompanied by a matching testkit major bump.
- **Tightening the contract is a major bump, or an opt-in case — never a
  minor bump.** If a change to an existing case could fail an adapter that
  passed before (a stricter assertion, a new mandatory case), it ships as a
  major version, or as a new case gated behind an opt-in fixture field so
  existing callers are unaffected until they adopt it.
- **Adding an optional fixture field, or a new case gated behind an existing
  optional field (e.g. `expectedConfigWatchTargets`), is a minor bump** — it
  cannot fail a fixture that doesn't set the field.
- **Validator-specific fixtures belong to each adapter package.** This
  package carries no fixtures for any one real validator (see
  `@vue-html-bridge/adapter-markuplint`'s own test suite for that); it only
  owns the fixture *shape* (`AdapterContractFixture`) and the fake/sample
  adapters used across the monorepo's own tests.
- **The fake adapter's API is a real, semver-covered test utility** — it is
  consumed directly by `@vue-html-bridge/analyzer` and
  `@vue-html-bridge/language-server`'s test suites, not just an internal
  implementation detail, so its shape changes follow the same semver
  discipline as any other export.
