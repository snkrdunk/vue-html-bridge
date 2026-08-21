import { describe, expect, it } from "vitest";
import { babelParse } from "@vue/compiler-sfc";
import {
  evaluate,
  isSideEffectFree,
  normalizePredicateKey,
  unknownFallback,
  type EvalEnv,
  type JsonPrimitive,
} from "./expression-evaluator.js";

function parseExpr(source: string): any {
  const program = babelParse(`(${source});`, {
    sourceType: "module",
    plugins: ["typescript"],
  }).program;
  const stmt = program.body[0];
  if (!stmt || stmt.type !== "ExpressionStatement") {
    throw new Error(`expected an ExpressionStatement, got ${stmt?.type}`);
  }
  return stmt.expression;
}

function envFrom(values: Record<string, JsonPrimitive>): EvalEnv {
  return {
    resolveDecisionValue(root, path) {
      const key = [root, ...path].join(".");
      if (!(key in values)) return { found: false };
      return values[key];
    },
  };
}

/**
 * core.md §4.6's expression-grammar → evaluator table, as executable rows.
 * Each row is `[grammar row name, expression source, env values, expected
 * EvaluationResult]`. This IS the committed fixture the design doc section
 * cites — see also FINDINGS.md for how each row was chosen from the design
 * doc's bullet list.
 */
describe("core.md §4.6 expression-evaluation table", () => {
  const rows: [
    string,
    string,
    Record<string, JsonPrimitive>,
    ReturnType<typeof evaluate>,
  ][] = [
    ["string literal", `'active'`, {}, { kind: "known", value: "active" }],
    ["numeric literal", `42`, {}, { kind: "known", value: 42 }],
    ["boolean literal", `true`, {}, { kind: "known", value: true }],
    ["null literal", `null`, {}, { kind: "known", value: null }],
    [
      "undefined identifier",
      `undefined`,
      {},
      { kind: "known", value: undefined },
    ],
    [
      "resolved property access",
      `props.loggedIn`,
      { "props.loggedIn": true },
      { kind: "known", value: true },
    ],
    [
      "parens (transparent to evaluation)",
      `(props.loggedIn)`,
      { "props.loggedIn": false },
      { kind: "known", value: false },
    ],
    [
      "! on a known value",
      `!props.loggedIn`,
      { "props.loggedIn": true },
      { kind: "known", value: false },
    ],
    [
      "=== against a literal",
      `props.status === 'active'`,
      { "props.status": "active" },
      { kind: "known", value: true },
    ],
    [
      "!== against a literal, false case",
      `props.status !== 'active'`,
      { "props.status": "active" },
      { kind: "known", value: false },
    ],
    [
      "== against null",
      `props.value == null`,
      { "props.value": null },
      { kind: "known", value: true },
    ],
    [
      "!= against null",
      `props.value != null`,
      { "props.value": "x" },
      { kind: "known", value: true },
    ],
    [
      "&& short-circuits on falsy left",
      `props.loggedIn && props.role`,
      { "props.loggedIn": false, "props.role": "admin" },
      { kind: "known", value: false },
    ],
    [
      "&& evaluates right when left is truthy",
      `props.loggedIn && props.role`,
      { "props.loggedIn": true, "props.role": "admin" },
      { kind: "known", value: "admin" },
    ],
    [
      "|| short-circuits on truthy left",
      `props.role || 'guest'`,
      { "props.role": "admin" },
      { kind: "known", value: "admin" },
    ],
    [
      "?? treats false as non-nullish (unlike ||)",
      `props.flag ?? 'fallback'`,
      { "props.flag": false },
      { kind: "known", value: false },
    ],
    [
      "ternary, known test",
      `props.loggedIn ? 'yes' : 'no'`,
      { "props.loggedIn": true },
      { kind: "known", value: "yes" },
    ],
    [
      "optional chaining on a supported expression",
      `props.user?.name`,
      { "props.user.name": "found this via the resolved access path" },
      { kind: "known", value: "found this via the resolved access path" },
    ],
  ];

  for (const [label, source, values, expected] of rows) {
    it(label, () => {
      const node = parseExpr(source);
      expect(evaluate(node, envFrom(values))).toEqual(expected);
    });
  }

  it("comparison against two non-literal decisions is explicitly unsupported (core.md §4.6: literal-or-null only)", () => {
    const node = parseExpr(`props.a === props.b`);
    const result = evaluate(node, envFrom({ "props.a": "x", "props.b": "x" }));
    expect(result.kind).toBe("unknown");
  });

  it("function calls are never evaluated, even when side-effect-free-looking", () => {
    const node = parseExpr(`checkPermission()`);
    const result = evaluate(node, envFrom({}));
    expect(result).toEqual({
      kind: "unknown",
      reason: "unsupported expression kind: CallExpression",
    });
  });

  it("an unresolved decision root yields unknown, not a thrown error", () => {
    const node = parseExpr(`props.somethingNotRegistered`);
    expect(evaluate(node, envFrom({})).kind).toBe("unknown");
  });
});

describe("core.md §4.6 predicate decision + unknown fallback", () => {
  it("a comparison the evaluator can't resolve (unregistered decision) is still side-effect-free and boolean-shaped -> eligible for predicate promotion", () => {
    const node = parseExpr(`props.items.length > 0`); // `>` isn't in the evaluator's operator set
    expect(evaluate(node, envFrom({}))).toEqual({
      kind: "unknown",
      reason: "unsupported binary operator: >",
    });
    expect(isSideEffectFree(node)).toBe(true);
  });

  it("a call expression is NOT side-effect-free, even if it looks boolean-shaped -> never promoted to a predicate decision", () => {
    const node = parseExpr(`checkPermission() > 0`);
    expect(isSideEffectFree(node)).toBe(false);
  });

  it("`!x` correlates with `x`'s own predicate key, negated (core.md §4.6)", () => {
    const positive = parseExpr(`props.items.length > 0`);
    const negated = parseExpr(`!(props.items.length > 0)`);
    const posKey = normalizePredicateKey(positive);
    const negKey = normalizePredicateKey(negated);
    expect(negKey.key).toBe(posKey.key);
    expect(posKey.negated).toBe(false);
    expect(negKey.negated).toBe(true);
  });

  it("two syntactically-different-but-equivalent expressions do NOT share a predicate key (only the SAME normalized expression correlates, per core.md §4.6)", () => {
    const a = normalizePredicateKey(parseExpr(`props.count > 0`));
    const b = normalizePredicateKey(parseExpr(`props.count > 1`));
    expect(a.key).not.toBe(b.key);
  });

  it("IF's unknown fallback always generates both branches locally, regardless of any static domain", () => {
    expect(unknownFallback("if", ["a", "b"])).toEqual({
      kind: "if-both-branches",
    });
    expect(unknownFallback("if", undefined)).toEqual({
      kind: "if-both-branches",
    });
  });

  it("v-bind's unknown fallback prefers a finite-union static domain over a dummy value", () => {
    expect(unknownFallback("v-bind", ["active", "inactive"])).toEqual({
      kind: "finite-union-candidates",
      values: ["active", "inactive"],
    });
  });

  it("v-bind falls back to a dummy value when no finite static domain exists", () => {
    expect(unknownFallback("v-bind", undefined)).toEqual({
      kind: "dummy-value",
      reason: "expression-not-symbolically-evaluable",
    });
  });
});
