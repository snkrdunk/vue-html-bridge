---
"vue-html-bridge": patch
---

Fix a crash ("Cannot convert object to primitive value") when a template's `:class` or `:style` binding is an array containing an object literal (the common `:class="[..., { active: isActive }]"` idiom). Array elements now recurse through the same attribute-value formatting used for a top-level object instead of being stringified directly, and `:style` merges multiple array entries into one declaration list, matching Vue's own `normalizeClass`/`normalizeStyle` behavior.
