import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectDecisions } from "./decision-collector.js";
import { findPropsTypeArg } from "./find-props-type.js";
import { createInjectedContext } from "./type-analysis-context.js";

const playground = (name: string) =>
  fileURLToPath(new URL(`../../examples/playground/${name}`, import.meta.url));

function collect(filename: string) {
  const source = readFileSync(filename, "utf-8");
  const ctx = createInjectedContext(new Map());
  return collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
}

describe("S1 spike: logged-in-aria-controls.vue", () => {
  const filename = playground("logged-in-aria-controls.vue");
  const result = collect(filename);

  it("resolves loggedIn as a boolean prop domain", () => {
    const loggedIn = result.resolvedProps.find((p) => p.name === "loggedIn");
    expect(loggedIn?.domain).toEqual({ kind: "boolean" });
  });

  it("finds a v-if decision and the :aria-controls ternary's condition, sharing the same DecisionIdentity", () => {
    const vIf = result.decisions.find((d) => d.site === "v-if");
    // `:aria-controls="props.loggedIn ? 'missing' : undefined"` is a ternary,
    // not a plain access path — its whole `v-bind` expression is expectedly
    // unresolved (see the "unresolved" test below); what's resolved is the
    // ternary's *condition*, which is exactly core.md §4.4's dedicated
    // "Ternary expression" row.
    const ternary = result.decisions.find(
      (d) => d.site === "ternary-condition",
    );
    expect(vIf).toBeDefined();
    expect(ternary).toBeDefined();
    // core.md §4.1: nav's v-if and button's :aria-controls ternary condition
    // both read `props.loggedIn` — they MUST resolve to the identical
    // DecisionIdentity so a shared VariantEnvironment can evaluate them
    // consistently.
    expect(vIf!.identity).toEqual(ternary!.identity);
    expect(vIf!.identity.symbolKey).toBe(`${filename}#props.loggedIn`);
    expect(vIf!.domain).toEqual({ kind: "boolean" });
  });

  it("the whole ternary v-bind expression is unresolved as a plain access path (by design)", () => {
    expect(result.unresolved).toEqual([
      { site: "v-bind", content: "props.loggedIn ? 'missing' : undefined" },
    ]);
  });
});

describe("S1 spike: status-literal-union.vue", () => {
  const filename = playground("status-literal-union.vue");
  const result = collect(filename);

  it("resolves status to its literal union, expanding the local type alias", () => {
    const status = result.resolvedProps.find((p) => p.name === "status");
    expect(status?.domain).toEqual({
      kind: "literal-union",
      values: ["active", "inactive", "pending"],
      nullable: false,
    });
  });

  it("resolves disabled as boolean", () => {
    const disabled = result.resolvedProps.find((p) => p.name === "disabled");
    expect(disabled?.domain).toEqual({ kind: "boolean" });
  });

  it("finds the plain v-bind decision for :disabled", () => {
    const disabledDecision = result.decisions.find(
      (d) => d.site === "v-bind" && d.expressionContent === "props.disabled",
    );
    expect(disabledDecision?.domain).toEqual({ kind: "boolean" });
  });

  it("the :class ternary's condition (`props.status === 'active'`) is a BinaryExpression, not a plain access path — the plain collector leaves it unresolved by design", () => {
    // core.md §4.6's "predicate decision" rule is what's meant to handle
    // this case (abstract the comparison's truthiness into an auxiliary
    // decision correlated with its own negation) — that's a job for the
    // expression evaluator, not this access-path matcher. Proven in
    // expression-evaluation-table.spike.test.ts instead.
    const classTernary = result.unresolved.find(
      (u) => u.site === "ternary-condition",
    );
    expect(classTernary?.content).toBe("props.status === 'active'");
  });
});

describe("S1 spike: item-list.vue", () => {
  const filename = playground("item-list.vue");
  const result = collect(filename);

  it("finds a v-for-source decision for props.items (array domain, unresolved element type)", () => {
    const forSource = result.decisions.find((d) => d.site === "v-for-source");
    // `items` is typed `Item[]` where `Item` is a same-file interface — this
    // spike's resolver only expands TSTypeAliasDeclaration/TSInterfaceDeclaration
    // for *scalar* domains, so an interface-typed array element is expected to
    // stay unsupported. What matters for core.md §4.5 is that the ARRAY shape
    // itself (not its element type) is what a `collection-cardinality`
    // decision needs, and that resolves correctly.
    expect(forSource?.domain.kind).toBe("array");
  });

  it("finds the v-if length check as an unresolved expression (binary comparison, not a plain access path)", () => {
    // `props.items.length === 0` is a BinaryExpression, not a MemberExpression
    // chain — core.md §4.6's "predicate decision" rule is what handles this,
    // not the plain access-path matcher. See expression-evaluation-table spike.
    expect(result.unresolved.some((u) => u.site === "v-if")).toBe(true);
  });
});
