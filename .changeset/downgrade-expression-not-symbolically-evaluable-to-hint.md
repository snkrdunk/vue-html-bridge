---
"vue-html-bridge": patch
---

Downgrade the `expression-not-symbolically-evaluable` diagnostic from `warning` to `hint` severity. This diagnostic fires once per template expression core cannot evaluate statically (e.g. a `v-if`/`v-show` condition calling a method), so on real components it is often the majority of a run's diagnostics and drowned out `warning`-and-above findings that actually need attention. It remains reported — just at the lowest severity, below `error`/`warning`/`info`.
