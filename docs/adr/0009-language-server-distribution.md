# ADR-0009: Language server ships standalone — no bundled editor client in v1

Status: Accepted
Date: 2026-08-24

## Context

language-server.md §14 left open "whether to bundle a minimal client
launcher in the language server package, or ship it as a separate
package," to be decided at Phase 3's initial release. This is a product
scope decision (implementation-plan.md's ADR backlog: "client launcher
packaging — confirm with the user before deciding"), not an implementation
detail — it determines whether this release includes any editor-specific
integration work at all.

No editor extension or client launcher code exists anywhere in this
repository today. `@vue-html-bridge/language-server` is already designed
and built (Phase 1/2) as "an editor-neutral language server that any
LSP-capable editor can use" (language-server.md §1), distributed as a
stdio-based Node.js binary (`vue-html-bridge-language-server --stdio`,
language-server.md §2).

Confirmed with the user (2026-08-24, via AskUserQuestion).

## Decision

**`@vue-html-bridge/language-server` ships as a standalone npm package —
the stdio binary and its library entry point only. No bundled editor
client (VS Code extension or otherwise) is part of Phase 3's initial
release.**

Any LSP-capable editor can connect to it by pointing at the published bin,
using each editor's own generic "run this language server" configuration
mechanism (e.g. a client's custom-server settings, or a thin user-authored
config) — no bespoke integration code is required for this to be usable.

## Consequences

1. **Design-doc update**: language-server.md §14's "bundle a minimal
   client launcher... or ship it as a separate package" open question is
   struck: resolved as "ship standalone; no client launcher in this
   release." No other design changes — §1/§2's existing "editor-neutral...
   any LSP-capable editor" framing already describes this outcome.
2. **Implementation task**: none added by this decision — it is the
   absence of a task (no `packages/vscode-extension` or similar is created
   for Phase 3). implementation-plan.md §6 is unaffected: it already scopes
   Phase 3 to `@vue-html-bridge/language-server` itself plus the shared
   adapter-loader/CLI work, not an editor extension.
3. **Verifying test**: none needed beyond what already exists —
   language-server's own protocol/E2E suite (Phase 1/2) already verifies
   the stdio server is usable by a generic LSP client; a bundled extension
   would need its own separate test surface that this decision avoids
   creating.

## Alternatives considered

- **Bundle a minimal reference client (e.g. a barebones VS Code
  extension) in Phase 3**: rejected — a real editor extension is a
  substantial, separately-scoped piece of work (its own packaging,
  marketplace distribution, and maintenance surface) beyond "everything
  needed for third parties, then the first npm publish of all production
  packages" (monorepo.md §13's framing of the initial release). Revisit as
  its own future release once there's a concrete signal (e.g. real user
  friction configuring generic LSP clients) that motivates it.
