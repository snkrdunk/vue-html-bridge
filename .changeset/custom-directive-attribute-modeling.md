---
"vue-html-bridge": minor
"@vue-html-bridge/settings": minor
"@vue-html-bridge/analyzer": patch
---

Add custom-directive attribute value modeling (ADR-0010). A new `customDirectives` setting (and core `GenerateOptions` field) declares which attributes a custom directive sets and how to derive each value from its bound expression — a literal string constant, or `$value` optionally followed by dotted property segments — closing the `required-attr` false-positive class for attribute-setting directives like `v-src`. The analyzer's generation-cache key now includes `customDirectives`, so two runs differing only in declared mappings can no longer collide on one cache entry.
