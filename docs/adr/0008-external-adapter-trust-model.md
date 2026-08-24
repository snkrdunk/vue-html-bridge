# ADR-0008: External adapter trust model — no sandboxing, no curated allowlist, no PnP in v1

Status: Accepted
Date: 2026-08-24

## Context

`@vue-html-bridge/adapter-loader` (adapter-loader.md) was already fully
designed — including its explicit statement that loading "remains a trust
boundary, not a security boundary" (§1 out-of-scope) — but three questions
were left open pending explicit user sign-off, since they are product
decisions about how much risk this project accepts on a user's behalf, not
ordinary implementation details (per this project's standing "judgment
scope vs. engineering" split, and implementation-plan.md's ADR backlog row:
"External-adapter specifier/PnP; sandboxing; client launcher packaging;
trust granularity — confirm with the user before deciding"):

1. **Sandboxing feasibility** (monorepo.md §15): should Phase 3 spike an
   actual code-isolation mechanism (e.g. worker-thread isolation with
   restricted capabilities) before external adapters ship, or ship the
   already-designed trust-boundary-only model as final for v1?
2. **Package specifier allowlist** (language-server.md §14): should loading
   be restricted to a maintainer-curated list of known-safe packages, or is
   "explicitly named in `settings.validators[]`, gated by workspace trust"
   sufficient?
3. **Yarn PnP support** (language-server.md §14): should the module
   resolver support Yarn PnP resolution in v1, alongside plain Node.js
   resolution?

Confirmed with the user (2026-08-24, via AskUserQuestion) after explaining
the trust-boundary-vs-security-boundary distinction in concrete terms:
a trust boundary is a consent gate (does the user explicitly agree to run
this code?); a security boundary is technical enforcement that constrains
what code can do even after consent is given. This project builds only the
former.

## Decision

**Ship exactly the design adapter-loader.md and language-server.md §10.2
already specify, with no additions:**

1. **No sandboxing.** External adapter code runs with the same privileges
   as any other npm dependency once the multi-step consent gate is passed
   (workspace trust + `externalAdapters: "trusted-workspace-only"` +
   explicit package name in `settings.validators[]`). No VM/worker isolation,
   no restricted filesystem/network access. Rationale: adapters
   legitimately need broad capabilities (Markuplint's own JS plugins/config
   resolve modules and read workspace files), a real security boundary is a
   large, well-studied problem this project is not attempting to solve, and
   a half-built sandbox risks false confidence worse than being explicit
   about relying on trust.
2. **No curated allowlist.** Any plain npm package specifier is accepted
   once the trust gate is passed — there is no maintainer-reviewed list of
   approved adapter packages. The user typing a specific package name into
   `settings.validators[].adapter` is itself the explicit, deliberate act
   of naming that package; a curated allowlist would add an ongoing
   maintenance/review burden (who decides "safe", how new legitimate
   adapters get added) without changing the fundamental trust-boundary
   model.
3. **No PnP support.** The module resolver in v1 uses plain Node.js
   resolution only (`AdapterModuleResolver`'s default implementation,
   adapter-loader.md §3). Yarn PnP is not evaluated further for v1 — no
   evidence in this codebase or its tooling (pnpm-based) suggests PnP
   resolution is needed yet, and `moduleResolver` is already designed as an
   injectable seam (adapter-loader.md §3) so PnP support can be added later
   without an API change if it's ever requested.

## Consequences

1. **Design-doc update**: monorepo.md §15's "Whether sandboxing external
   adapters is feasible" open question is struck with this resolution.
   language-server.md §14's "Package specifier allowlist and PnP support"
   open question is struck with this resolution. adapter-loader.md's
   design (already written assuming this outcome) needs no changes — it was
   correct in advance.
2. **Implementation task**: implementation-plan.md §6 item 3 ("Shared
   adapter loading + trust") — `@vue-html-bridge/adapter-loader` is
   implemented exactly per its existing design, with no sandboxing
   subsystem and no allowlist/PnP configuration surface.
3. **Verifying test**: adapter-loader.md §6's gate-matrix tests (item 1)
   confirm the documented gates fire and nothing more is checked; a test
   asserting a non-curated, arbitrary-but-explicit package specifier loads
   successfully once trust is granted (no allowlist lookup happens);
   `moduleResolver` is exercised only through its injectable Node-resolution
   default, with no PnP-specific code path to test.

## Alternatives considered

- **Prototype worker-thread isolation before deciding**: rejected for v1 —
  no concrete threat model or user request motivates the added complexity
  right now; revisit as a separate major-version ADR if external adapter
  usage in practice surfaces a real need.
- **Curated allowlist**: rejected — shifts risk from "the user's own
  explicit choice" to "the project's ongoing editorial judgment", which is
  a different (and heavier) kind of responsibility than this project is
  taking on for v1.
- **PnP support now**: rejected — no current evidence of demand; the
  resolver seam already makes this a non-breaking addition later.
