# ADR-0010: Custom-directive attribute value modeling ("Plan B")

Status: Accepted
Date: 2026-08-27

## Context

Running `@vue-html-bridge/cli` against a real project
(`/Users/masato.nagashima/dev/bridge-test/typescript/src/components/ShippingFeeLabel.vue`)
produced a `required-attr` error claiming `<img>` is missing `src`/`srcset`.
Investigation found the root cause: the image uses a **custom directive**,
`v-src="'/img/common/pin-icon.svg'"`, whose runtime effect
(`el.setAttribute('src', assetUrl(binding.value))`, plus a `getSSRProps`
hook) core cannot statically know. Per the existing, documented design
(core.md §5.3), an unrecognized custom directive is stripped from the
generated HTML and a `warning`-severity `custom-directive-not-modeled`
diagnostic is emitted instead — so the generated `<img>` genuinely has no
`src`, and Markuplint correctly flags the generated HTML. This is a real,
recurring false-positive class for any codebase using attribute-setting
custom directives.

Two remediation designs were discussed with the user:

- **Option A (existence-only):** declare which attribute *names* a
  directive sets; core emits a placeholder value. Cheap, but doesn't help
  value-sensitive validator rules (e.g. a `role` value check, or a `src`
  URL pattern check).
- **Option B (full value modeling):** additionally declare, per attribute,
  how to derive its *value* from the directive's bound expression, reusing
  core's existing side-effect-free expression evaluator (core.md §4.6).

The user explicitly chose **Option B** ("多少重かったとしても、B案で行きましょう"),
after being walked through the trust caveat: a declared mapping is an
**unverified assertion** about a directive's real behavior — core can never
execute the directive's own `mounted`/`updated`/`getSSRProps` code, only the
*bound expression written in the template*. A wrong/stale declaration can
convert a real, safe-by-default warning into a false negative. This mirrors
ADR-0008's trust-boundary-not-security-boundary framing for external
adapters, applied here to declarative config instead of executable code.

**A design correction made during planning:** the originally-sketched
mechanism — textually substitute `$value` → `(${boundExpression})` into a
template string, then re-run it through the existing expression evaluator
unchanged — does not work. `expressions.ts`'s `accessPath()` requires a
property-access chain to bottom out at an `Identifier` resolved through
`environment.resolve(path)`; it never evaluates a sub-expression to a value
and then indexes into that value. So a substituted expression like
`"({ src: iconUrl, height: 24 }).src"` always falls through to
`unsupported:PropertyAccessExpression`, regardless of whether `iconUrl`
itself is resolvable — silently breaking the exact case that motivated
choosing Option B over A: multi-attribute fan-out from one bound object.

## Decision

Evaluate a directive's bound expression **once** (exactly as `renderBind`
does today for `v-bind="obj"`), then restrict each attribute's value
*template* to one of two fixed shapes, validated at settings-resolution
time and re-validated defensively in core:

- a **literal string constant** (no `$value` token) — emitted verbatim,
  **never parsed as an expression**: `"role": "status"` means the literal
  string `status`, not a reference to a `status` binding; or
- **`$value`**, optionally followed by dotted property segments (`$value`,
  `$value.src`, `$value.a.b`) — resolved by plain, own-properties-only
  property lookup on the already-evaluated value, not a second evaluator
  pass.

This is strictly more capable than Option A (bound literals, decision-bound
ternaries, and direct property references now resolve to real values;
multi-attribute fan-out works correctly) and needs zero changes to
`expressions.ts`. Full design: core.md §5.3.1.

**Further decisions made while implementing this design:**

1. **Decision collection.** `DecisionCollector.walk()` must also register a
   decision for a declared directive's bound expression when its mapping
   contains at least one `$value`-path template — exactly like `v-bind`/
   `v-model` — or a decision-bound branch inside that expression would
   silently collapse to the sentinel path in every generated variant. An
   **all-constant** mapping deliberately does *not* register a decision,
   since it never evaluates its bound expression at all; registering one
   anyway would only multiply variants with identical HTML.
2. **Camelized name matching.** Vue's `resolveDirective` camelizes directive
   names, so `v-img-attr` and `v-imgAttr` both reach a directive registered
   as `imgAttr`. Declared names and the template's `DirectiveNode.name` are
   both camelized before matching (mirroring the `.camel` `v-bind`
   modifier's own idiom), and settings deduplicates on the camelized name.
3. **Literal-string semantics.** An earlier draft ran constants through the
   expression evaluator, which made bare words — the most common attribute
   values (`status`, `polite`, `img`) — parse as unresolvable identifiers
   and silently produce placeholder values, while `"true"`/`"24"`/
   `"'status'"` happened to work by accident. Constants are literal
   strings, full stop; no constant can ever hit the sentinel path, and no
   quoting-inside-JSON is ever needed.
4. **Reject-all camelized-duplicates (no wins-rule).** Two or more entries
   colliding on their camelized name are **all** dropped in core, rather
   than the more obvious "last one wins" (or "first one wins"). A wins-rule
   is array-order-dependent, but the analyzer's cache-key normalizer sorts
   `customDirectives` entries by name (for a deterministic, order-insensitive
   key) — so `[A, B]` and `[B, A]` would hash to the *same* cache key while a
   wins-rule would give them *different* semantics, a genuine
   cache-collision bug. Rejecting every collider keeps mapping semantics
   order-insensitive, matching the order-insensitive key. (Settings-level
   validation is unaffected: it already errors and keeps only the first
   entry, so core never sees duplicates coming from resolved settings —
   this defensive behavior only matters for a direct core-API caller that
   bypasses settings.)
5. **Reserved-directive-name rejection.** A mapping declared for a built-in
   or control directive name (`bind`, `on`, `model`, `text`, `html`, `slot`,
   `pre`, `if`, `else-if`, `else`, `for`, `show`, `once`, `memo`, `cloak`)
   is dropped in both settings and core: the dispatch order makes such a
   mapping unreachable dead config, so rejecting it makes that fact
   explicit and testable instead of silently doing nothing.
6. **Own-properties-only `$value` lookup.** `$value.constructor` /
   `$value.toString` / `$value.__proto__` must never resolve an inherited
   value into attribute output — a cheap hardening measure (`Object.hasOwn`)
   given that values arriving through `environment.resolve` from binding
   domains carry no prototype-less guarantee the evaluator's own object
   literals do.
7. **Core-side defensive re-validation.** Settings-file validation
   (settings.md §3.1) is the primary surface, with per-field error messages
   at config-load time, but a direct core-API caller bypasses it — so core
   re-checks attribute-name keys, value-template grammar, reserved names,
   and camelized duplicates itself, reporting one
   `custom-directive-mapping-invalid` warning per
   rejected item, anchored at the template range (options carry no source
   location of their own — the same anchoring precedent as
   `large-variant-space`).
8. **No CLI flag.** `customDirectives` is config-file only. `validators[]`
   is the only existing comparably-rich field, and it needed three
   dedicated flags plus dotted-path/deep-set machinery specific to itself;
   cli.md §4.2 already states nested/rich fields belong in the config file.
9. **Settings-time constant expressions were not a viable alternative for
   validating constants.** Settings has no runtime dependency on core's
   expression evaluator, so any settings-time check of a constant's
   "expression validity" would degrade to a literal-only syntax pattern
   anyway — i.e. the same restriction adopted here, with worse ergonomics
   (quoting rules users would have to learn for no benefit).

## Consequences

1. **Design-doc update:** core.md §2.1 (new `customDirectives` field on
   `GenerateOptions`, cache-key-JSON-compatibility note), §5.3 (directive
   table row now conditional on a declared mapping), new §5.3.1 (full
   semantics). settings.md §3/§3.1/§6/§8 (new input/resolved types,
   validation rules, decomposition routing, tests list). cli.md §4.2/§5/§9
   (no flag + why, `--untrusted`-unaffected, extended test description).
   language-server.md §9.2 (decomposition-routing sentence extended).
2. **Implementation task:** core's `generate.ts` (parsing, dispatch,
   rendering, decision collection), `types.ts` (`CustomDirectiveMapping`);
   settings' `schema.ts`/`resolve.ts`/`json-schema.ts`/`decompose.ts`
   (validation, decomposition, published schema); analyzer's
   `generation-cache.ts` (cache-key normalization fix, below); one CLI e2e
   fixture proving settings-file → CLI → analyzer → core wiring.
3. **Verifying test:** core's `index.test.ts` (single/multi-attribute
   resolution and provenance, unresolvable-expression fallback, the
   null/undefined/false drop rule, decision-bound branching, undeclared-
   directive dispatch regression, literal-constant semantics, camelized
   matching both directions, all-constant mappings registering no decision,
   core-side defensive validation, own-properties-only lookup); settings'
   `resolve.test.ts`/`decompose.test.ts`/`json-schema.test.ts`/
   `contract.test.ts` (including the intentionally-duplicated
   `ATTRIBUTE_NAME_PATTERN`/`VALUE_PATH_PATTERN`/reserved-name-set pins
   against core's real exports); analyzer's `generation-cache.test.ts`
   (cache-key correctness fix, below, plus an exhaustive per-`GenerateOptions`-
   field guard); a new CLI e2e case reproducing the original false positive
   end to end and showing it disappears with a declared mapping.

**A cache-key correctness fix found during plan review, not in the original
discussion:** `packages/analyzer/src/cache/generation-cache.ts`'s
`normalizeGenerateOptions` explicitly whitelists fields into the core
result-cache key (analyzer.md §10.1: "a cache hit is trusted on the key
alone"). Left unwired, two calls with the same source/filename but
different `customDirectives` would collide on the same cache key and
silently serve a stale/wrong `GenerateResult` — a real correctness bug, not
cosmetic. Fixed by sorting `customDirectives` (both entry order and each
entry's own attribute-key order) into the key, exactly like `customElements`
already is. This sort is *sound*, not just deterministic, only because
core rejects camelized-duplicate mappings outright (Decision point 4 above)
— with duplicates rejected, there is no wins-rule, so an order-insensitive
key can never conflate two differently-behaving options objects.

## Alternatives considered

- **Widen the expression evaluator** to support indexing into an
  already-evaluated sub-expression (the mechanism the original,
  incorrect sketch assumed): rejected for v1 — the two-fixed-shapes grammar
  above covers every case actually needed (literal bindings, decision-bound
  ternaries, direct property references, multi-attribute fan-out) without
  touching `expressions.ts` at all. Revisit only if a real need for
  arbitrary expression substitution emerges.
- **Unified attribute-write conflict resolution** (static / `v-bind` /
  `v-model` / custom mappings writing the same attribute name, one winner
  + warning; proposed in external review): deferred to its own change.
  Duplicate attribute output is a pre-existing behavior class (static +
  `v-bind` already collide identically today, with no resolution), the
  winner rule needs real investigation against Vue's actual runtime merge
  semantics (`class`/`style` merging, `v-model` precedence), and a unified
  resolver would change generated output for existing inputs — its own
  design, its own ADR.
- **A `$$value` escape** for a constant that needs to contain the literal
  text `$value` (proposed in external review): deferred. Today such a
  template is a loud settings error at config-load time, not a silent
  misinterpretation; no real need has been demonstrated; and adding the
  escape later only makes previously-invalid input valid — a
  backward-compatible extension, not a breaking one.
- **A curated directive registry, or sandboxed/verified execution of a
  directive's real implementation:** out of scope entirely — this project
  builds a trust boundary, not a security boundary (ADR-0008), and neither
  option changes that; both add substantial complexity for a problem this
  design already solves adequately via an explicit, documented trust
  caveat.
