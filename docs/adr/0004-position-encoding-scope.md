# ADR-0004: Position-encoding support scope

Status: Accepted
Date: 2026-08-21

## Context

language-server.md §5 defers the initial non-UTF-16 support scope to "Phase
0 will settle the target client matrix." implementation-plan.md §3.3 (Spike
S3) required both a UTF-16 round-trip prototype (offset ↔ Position across
CRLF, emoji, combining marks, zero-width ranges) and a survey of the target
LSP client matrix for `positionEncodings` support.

The spike's real code lives in `spikes/s3-utf16-lsp/` —
`position-index.ts` (the `PositionIndex` prototype), `round-trip.spike.test.ts`
(8 passing tests), and `client-matrix.md` (the full sourced client survey).

## Decision

**Phase 1 stays UTF-16-only.** `ServerCapabilities.positionEncoding` always
negotiates to UTF-16 for the initial release; no UTF-8/UTF-32 converter ships
in Phase 1. **Phase 2 Track 3 puts UTF-8 and UTF-32 support explicitly in
scope** (not indefinitely deferred) — implementation-plan.md §5 Track 3 item
5 already lists this conditionally ("if and only if ADR-0004 put them in
scope"); this ADR resolves that condition to yes.

### Why UTF-16-only for Phase 1

The two highest-share LSP clients checked do not negotiate
`general.positionEncodings` at all today:

- **VS Code**'s `vscode-languageclient` library — which underlies the large
  majority of VS Code LSP extensions — has open, unaddressed feature
  requests for this (`microsoft/vscode-languageserver-node` #748 and its
  reopened successor #1224), with no maintainer commitment found.
- **Zed** hard-codes UTF-16 for LSP communication today (per its own "Text
  Coordinate Systems" post), converting from its native UTF-8 rope
  representation on every LSP interaction rather than negotiating.

Since these clients always assume UTF-16 (the LSP spec's mandatory fallback
when a client sends no `positionEncodings` capability), a server that
shipped only a non-UTF-16 encoding, or that failed to default correctly,
would be broken for most users immediately. UTF-16 must remain both
supported and the default.

### Why Phase 2 (not "never") for UTF-8/UTF-32

Real, actively-maintained clients do negotiate and prefer a non-UTF-16
encoding: Neovim's built-in client (`utf-8, utf-16, utf-32` preference
order), Helix (`utf-8, utf-32, utf-16`), and Emacs Eglot
(`utf-32, utf-8, utf-16`) — see `client-matrix.md` for sourced PRs/issues for
each. This is a real minority population, not theoretical.

The round-trip spike proves the conversion math is correct and cheap:
`position-index.ts` implements `offsetToPosition`/`positionToOffset` for all
three `PositionEncodingKind` values by tracking per-code-point UTF-8 byte
width and UTF-32 code-point counts alongside the existing UTF-16 line index —
no new algorithmic approach is needed, and the fixtures (CRLF, emoji
surrogate pairs at mid-line and line-boundary positions, combining-character
sequences confirmed to stay as separate UTF-16 units rather than merged
grapheme clusters, zero-width ranges at document start/end/mid-surrogate-pair)
all round-trip correctly across all three encodings. Two real edge-case bugs
were found and fixed during the spike (documented in
`round-trip.spike.test.ts`): a dead/inverted mid-surrogate-pair detection
condition, and a missing error case for an offset landing between `\r` and
`\n` of a CRLF pair (no valid Position exists there in any encoding — must
throw, not silently produce a wrong line/character).

Given the math is already proven, Phase 2 Track 3's job is productionizing
`position-index.ts` into `packages/language-server/src/positions.ts` and
wiring `ServerCapabilities.positionEncoding` negotiation against the client's
offered list — not new research.

## Consequences

1. **Design-doc update**: language-server.md §5 states the settled scope
   plainly: "The initial implementation (Phase 1) supports UTF-16 only.
   UTF-8 and UTF-32 converters are in scope for Phase 2 (ADR-0004)," replacing
   "Phase 0 will settle the target client matrix." §14's open-questions list
   strikes the corresponding entry.
2. **Implementation task**: implementation-plan.md §4 Step 6 (language server,
   minimal) keeps "UTF-16 position encoding only" as already written — no
   change needed there. implementation-plan.md §5 Track 3 item 5's
   conditional ("if and only if ADR-0004 put them in scope") resolves to
   "yes, implement it," using `spikes/s3-utf16-lsp/position-index.ts` as the
   starting point rather than a from-scratch design.
3. **Verifying test**: `spikes/s3-utf16-lsp/round-trip.spike.test.ts` (8
   tests) is the evidence for this ADR's technical claim (the conversion math
   works for all three encodings). language-server.md §13.1 unit test 1
   ("UTF-16/UTF-8/UTF-32 position conversion, CRLF, emoji, zero-width")
   already exists in the design doc's test list and is implemented for real
   in Phase 2 Track 3 per the traceability appendix — this ADR does not
   change that assignment.

## Alternatives considered

- **UTF-8-only or UTF-32-only, dropping UTF-16**: rejected outright — would
  break VS Code and Zed, the two highest-share clients, which never send a
  non-UTF-16 default.
- **Deferring UTF-8/UTF-32 indefinitely (never revisit without a specific
  user request)**: rejected — the client matrix shows real, non-trivial
  demand today, and the conversion math is already proven cheap; deferring
  further would just mean re-deriving the same math later for no benefit.
- **Implementing all three encodings in Phase 1**: rejected — Phase 1's
  scope is deliberately minimal (implementation-plan.md §4), and no client
  that matters for the internal Phase 1 milestone needs anything but UTF-16;
  adding the negotiation/wiring now would be scope creep against an
  unvalidated need at that stage.
