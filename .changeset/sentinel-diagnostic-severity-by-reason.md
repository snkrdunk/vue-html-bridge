---
"@vue-html-bridge/analyzer": patch
---

Base the severity of `vue-html-bridge/non-finite-attribute-value` and `vue-html-bridge/unresolved-expression-value` on why the value could not be resolved, instead of inheriting the wrapped validator rule's severity (previously often `error`, even though these diagnostics report an analysis limitation rather than a confirmed markup violation). `non-finite-type` (the bound type is too broad to narrow, e.g. `pressed: string`) is now `warning`; `unresolved-expression` (core's evaluator couldn't evaluate the expression at all, e.g. `!item.isSold`) is now `info`.
