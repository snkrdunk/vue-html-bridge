---
"@vue-html-bridge/analyzer": minor
"@vue-html-bridge/cli": minor
---

Add `--emit-html <dir>` CLI flag for debugging generated HTML. When passed, writes each generated HTML variant (using the existing content-hash-keyed virtual-filename convention) plus a JSON sidecar correlating it back to the source-level decisions and mapping that produced it. Opt-in only; no behavior change when the flag is omitted. See ADR-0011 for the design rationale.
