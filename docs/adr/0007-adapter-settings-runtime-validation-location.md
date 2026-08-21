# ADR-0007: Where runtime validation of adapter settings happens

Status: Accepted
Date: 2026-08-21

## Context

analyzer.md §13 left open "whether runtime schema validation of adapter
settings is done by the language server or by the analyzer," to be decided
during Phase 1 implementation — implementation-plan.md §4's Phase 1 exit
criteria requires this decision recorded (with the usual design-doc-update /
implementation-task / verifying-test follow-through) even though the actual
implementation lands later, in Phase 2 Track 4, and must ship before Phase 3
exposes external adapters (untrusted, less-audited settings shapes raise the
stakes).

`ConfiguredAdapter.settings` (analyzer.md §2) reaches an adapter as the
`AdapterSessionContext.settings` value passed into `createSession` —
typed `TSettings` at compile time, but at runtime it is whatever JSON value
survived settings resolution (`@vue-html-bridge/settings`, settings.md §4)
and per-entry decomposition (settings.md §6). Nothing today confirms that
value is actually JSON-safe before it reaches the adapter.

## Decision

**The analyzer validates adapter settings at the point it calls
`createSession`, not either host.** Both `@vue-html-bridge/language-server`
and `@vue-html-bridge/cli` construct `ConfiguredAdapter[]` from the same
shared settings package (settings.md §4, cli.md §4.1) and hand it to
`createWorkspaceAnalyzer`/`reconfigure` — the analyzer is the one place both
hosts already funnel through before an adapter ever sees its settings, so
validating there covers both hosts from a single implementation instead of
two.

This is deliberately a **shallow, adapter-agnostic** check — is the value a
JSON-safe plain object (analyzer.md's own dependency on `@vue-html-bridge/validator-api`
already gives it that vocabulary: `JsonValue`, and the same is-it-JSON-safe
pattern validator-api's own runtime checks use) — not a deep,
per-adapter-shape validation. validator-api v1 defines no mechanism for an
adapter to publish a settings schema, and `@vue-html-bridge/settings`
explicitly excludes "interpreting adapter settings" from its own role
(monorepo.md's package table) — there is no schema to validate *against*
beyond "is this safe to hand to `createSession` and to hash into a cache
key (analyzer.md §10.2)." A settings value that fails this check is a
session-creation-time `AdapterSessionFailure` with
`code: "configuration-error"` (validator-api §3.1), isolated to that one
adapter exactly like any other session failure (analyzer.md §9.2) — not a
new failure category.

This does **not** add a new dependency edge to `@vue-html-bridge/settings`
in monorepo.md §4.1's graph: the check only needs `JsonValue`-shape logic
already reachable through analyzer's existing `validator-api` dependency.

## Consequences

1. **Design-doc update**: analyzer.md §13's open-questions entry is struck
   with this resolution; analyzer.md §9.2 (adapter failure handling) gains a
   note that a settings-shape failure surfaces through the same
   `AdapterSessionFailure` path as any other session-creation failure.
2. **Implementation task**: Phase 2 Track 4 (implementation-plan.md §5,
   "Settings foundation... Runtime validation of `validators[].settings` per
   the Phase 1 decision — must be in place before Phase 3 exposes external
   adapters"), already tracked — this ADR does not add a new task, it
   resolves which package the existing task's code lives in.
3. **Verifying test**: added with that Phase 2 Track 4 implementation — a
   fixture adapter/settings pair where the settings value is not JSON-safe
   (e.g. contains a function or a circular reference) must produce a
   session-level `configuration-error` `AdapterSessionFailure` from the
   analyzer, isolated to that one adapter, with core diagnostics and other
   adapters' results unaffected (the same guarantee analyzer.md §12 test 10
   already covers for a real adapter's own session failure).

## Alternatives considered

- **Language server validates, CLI duplicates the same check**: rejected —
  two implementations of "is this JSON-safe" is pure duplication for zero
  benefit, and it would be easy for the two to drift the same way
  monorepo.md already warns against for settings decomposition in general
  (language-server.md §9.2: "a new settings field must be routed in
  settings.md's decomposition table... rather than in either host").
- **`@vue-html-bridge/settings` validates, both hosts call it before
  building `ConfiguredAdapter[]`**: rejected for v1 — `@vue-html-bridge/settings`
  explicitly does not interpret adapter-specific settings (monorepo.md's
  package table), and adding "validate this arbitrary per-adapter JSON
  value" to its scope would blur that line for a check that has nothing to
  do with the *bridge's own* settings schema. Revisit only if a real
  per-adapter settings *schema* mechanism is added to validator-api later
  (no such mechanism exists in v1).
