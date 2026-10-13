---
"@vue-html-bridge/analyzer": patch
---

Fix `approximateGenerateResultBytes` undercounting a cached generation result's size: it now accounts for each variant's `decisions` (previously dropped entirely) and for a mapping entry's nested `provenance`/`sourceRange` payload (previously flattened to a fixed 64-byte guess, ignoring an arbitrarily long `sourceRange.filename`). `maxApproximateBytes` now correctly bounds real cache memory for files with many variants or long paths.
