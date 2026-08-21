# S3 — LSP client `positionEncodings` matrix (feeds ADR-0004)

Research date: 2026-08-21. LSP 3.17 introduced `general.positionEncodings`: a
client-advertised, preference-ordered array of `"utf-8" | "utf-16" | "utf-32"`.
UTF-16 is the only mandatory encoding — if a client omits the capability
entirely, the server MUST assume UTF-16 (LSP 3.18 spec, §Client Capabilities /
`PositionEncodingKind`).

| Client | Sends `general.positionEncodings`? | Encodings offered (preference order) | Notes / source |
| --- | --- | --- | --- |
| **VS Code** (`vscode-languageclient`, used by essentially every VS Code LSP extension) | **No**, as of the last confirmed state of the library | — (defaults to UTF-16 per spec) | `microsoft/vscode-languageserver-node` issue [#748](https://github.com/microsoft/vscode-languageserver-node/issues/748) ("UTF-8 Support") and its reopened successor [#1224](https://github.com/microsoft/vscode-languageserver-node/issues/1224) are both still open, labeled `feature-request`/`help wanted`, no maintainer commitment or linked PR found. The client library — which underlies the large majority of VS Code LSP extensions — has not implemented capability negotiation. |
| **Zed** | No | — (UTF-16 only) | Zed's own blog post ["Text Coordinate Systems"](https://zed.dev/blog/zed-decoded-text-coordinate-systems) states Zed maintains internal `OffsetUtf16`/`PointUtf16` coordinate types *specifically* to talk to language servers, converting from its native UTF-8 rope representation each time — i.e. Zed hard-codes UTF-16 for LSP today rather than negotiating. |
| **Neovim** (built-in `vim.lsp` client) | **Yes** | `utf-8, utf-16, utf-32` (non-UTF-16 preferred) | Implemented via [neovim/neovim#23865](https://github.com/neovim/neovim/issues/23865) and refined by [#30034](https://github.com/neovim/neovim/issues/30034) / [#31249](https://github.com/neovim/neovim/pull/31249) (which made `offset_encoding` a required, per-client field rather than a shared buffer assumption). Each attached client stores its own negotiated `offset_encoding`, read from the server's `capabilities.positionEncoding` response or defaulting to `utf-16`. |
| **Helix** | Yes | `utf-8, utf-32, utf-16` | [helix-editor/helix#5894](https://github.com/helix-editor/helix/pull/5894) ("Negotiate LSP Position Encoding"); `helix-lsp/src/client.rs` sends this array on initialize. Helix requests byte offsets (UTF-8) or code-point offsets (UTF-32) from servers that support them, falling back to UTF-16 only for older servers. |
| **Emacs Eglot** | Yes | `utf-32, utf-8, utf-16` | `emacs-29` commit "Eglot: support positionEncoding LSP capability" (2023-02); prefers UTF-32 (simplest 1:1 mapping to Emacs's internal character-based buffer positions), then UTF-8, then UTF-16 as last resort. |
| **coc.nvim** | Unconfirmed | Likely UTF-16-compatible only | coc.nvim is a Node.js extension host modeled closely on VS Code's extension APIs (it explicitly markets itself as loading "extensions like VSCode"); no evidence found of `general.positionEncodings` negotiation in its LSP client. Community guidance recommends users set Vim's own `encoding=utf-8`, which is about buffer/display encoding, not LSP wire position encoding, and doesn't imply capability negotiation. Treat as UTF-16-only until proven otherwise. |
| **Sublime Text** (`sublimelsp/LSP`) | Unconfirmed | Unconfirmed | No direct evidence of `general.positionEncodings` implementation found in the time available for this spike; the package is actively maintained ([sublimelsp/LSP](https://github.com/sublimelsp/LSP)) and LSP 3.17+ features are added incrementally, so this should be re-checked before Phase 2 Track 3 rather than assumed either way. |
| **clangd** (server-side reference point, not a client) | n/a | Implements LSP 3.17 `positionEncoding` on the server side | Cited only to show the ecosystem is bidirectionally moving toward negotiation, e.g. the clangd LLVM patch "[clangd] Implement LSP 3.17 positionEncoding" (2025). |

## Conclusion / recommendation for ADR-0004

**UTF-16 must remain the baseline and cannot be dropped**: the two highest-share
clients checked — VS Code's `vscode-languageclient` library (by far the
largest LSP client population) and Zed — do not negotiate at all today and
will always receive UTF-16 regardless of what the server offers. Any
vue-html-bridge language server that assumed non-UTF-16 was safe to rely on
would be broken for most users out of the gate.

At the same time, there is genuine, actively-maintained adoption of
`general.positionEncodings` negotiation among non-VS-Code clients — Neovim,
Helix, and Emacs/Eglot all send it today and prefer a non-UTF-16 encoding
when available. This is a real (if minority) user population, not a
theoretical one, and this spike (`round-trip.spike.test.ts`,
`position-index.ts`) proves the UTF-8/UTF-32 conversion math is correct and
cheap to implement — it required no new algorithmic work, just tracking
per-code-point UTF-8 byte width and UTF-32 code-point counts alongside the
existing UTF-16 line index.

**Recommendation**: language-server.md §5's Phase 1 scope stays UTF-16-only
(matches implementation-plan.md's existing Step 6 assumption — no client that
matters for an initial release needs anything else). For Phase 2 Track 3,
put UTF-8 and UTF-32 converters **in scope** (not deferred indefinitely):
the client matrix justifies it, and this spike's `position-index.ts`
prototype can be adapted directly into `packages/language-server/src/positions.ts`
rather than designed from scratch — Phase 2's task is mostly wiring
(`ServerCapabilities.positionEncoding` negotiation using the client's
`general.positionEncodings` preference list) plus productionizing this
prototype, not new research.

Sources:
- [LSP 3.18 Specification — Position Encoding / Client Capabilities](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)
- [microsoft/vscode-languageserver-node#748 — UTF-8 Support](https://github.com/microsoft/vscode-languageserver-node/issues/748)
- [microsoft/vscode-languageserver-node#1224 — UTF-8 support (reopened)](https://github.com/microsoft/vscode-languageserver-node/issues/1224)
- [Zed — Text Coordinate Systems](https://zed.dev/blog/zed-decoded-text-coordinate-systems)
- [neovim/neovim#23865 — lsp: add support for general.positionEncodings](https://github.com/neovim/neovim/issues/23865)
- [neovim/neovim#30034 — LSP: promote utf-8 and utf-32 positionEncodings](https://github.com/neovim/neovim/issues/30034)
- [neovim/neovim#31249 — feat(lsp)!: make offset_encoding required](https://github.com/neovim/neovim/pull/31249)
- [helix-editor/helix#5894 — Negotiate LSP Position Encoding](https://github.com/helix-editor/helix/pull/5894)
- [emacs-29 — Eglot: support positionEncoding LSP capability](https://lists.gnu.org/archive/html/emacs-diffs/2023-02/msg00682.html)
- [sublimelsp/LSP](https://github.com/sublimelsp/LSP)
- [neoclide/coc.nvim](https://github.com/neoclide/coc.nvim)
