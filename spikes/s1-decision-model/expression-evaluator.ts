// Spike fixture for core.md §4.6: a real, runnable implementation of the
// "expression grammar → evaluator" subset, proving each listed grammar shape
// actually reduces to an `EvaluationResult`, plus the predicate-decision and
// unknown-fallback rules layered on top. This is the artifact §4.6 says
// "will be fixed as a Phase 0 spike fixture."

export type JsonPrimitive = string | number | boolean | null | undefined;

export type EvaluationResult<T = JsonPrimitive> =
  { kind: "known"; value: T } | { kind: "unknown"; reason: string };

export interface EvalEnv {
  /** Looks up the assigned value of a decision by its resolved access path (root + path), or undefined if this access path isn't a known decision. */
  resolveDecisionValue(
    root: string,
    path: readonly (string | number)[],
  ): JsonPrimitive | { found: false };
}

function known<T>(value: T): EvaluationResult<T> {
  return { kind: "known", value };
}
function unknown(reason: string): EvaluationResult<never> {
  return { kind: "unknown", reason };
}

function toAccessPath(
  node: any,
): { root: string; path: (string | number)[] } | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") {
    return { root: node.loc?.identifierName ?? node.name, path: [] };
  }
  if (
    (node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression") &&
    !node.computed
  ) {
    const base = toAccessPath(node.object);
    if (!base) return undefined;
    return { root: base.root, path: [...base.path, node.property.name] };
  }
  return undefined;
}

/**
 * Grammar subset from core.md §4.6:
 * literals / identifiers / resolved property access / parens; `!`;
 * `===`/`!==`/`==`/`!=` vs. literal-or-null; `&&`/`||`/`??`; ternary;
 * optional chaining on a supported expression.
 *
 * Anything else (function/constructor calls, assignment/update, `await`,
 * unsupported operators) is explicitly NOT evaluated — callers must not add
 * cases here without also updating core.md §4.6.
 */
export function evaluate(node: any, env: EvalEnv): EvaluationResult {
  if (!node) return unknown("empty expression");

  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return known(node.value);
    case "NullLiteral":
      return known(null);
    case "Identifier":
      if (node.name === "undefined") return known(undefined);
      return resolveAccessPathOrUnknown(node, env);

    case "MemberExpression":
    case "OptionalMemberExpression":
      return resolveAccessPathOrUnknown(node, env);

    case "UnaryExpression": {
      if (node.operator !== "!") {
        return unknown(`unsupported unary operator: ${node.operator}`);
      }
      const arg = evaluate(node.argument, env);
      if (arg.kind === "unknown") return arg;
      return known(!arg.value);
    }

    case "BinaryExpression": {
      const supported = new Set(["===", "!==", "==", "!="]);
      if (!supported.has(node.operator)) {
        return unknown(`unsupported binary operator: ${node.operator}`);
      }
      const leftIsLiteralOrNull = isLiteralOrNull(node.left);
      const rightIsLiteralOrNull = isLiteralOrNull(node.right);
      if (!leftIsLiteralOrNull && !rightIsLiteralOrNull) {
        return unknown(
          "comparison operators are only supported against a literal or null (core.md §4.6)",
        );
      }
      const left = evaluate(node.left, env);
      const right = evaluate(node.right, env);
      if (left.kind === "unknown") return left;
      if (right.kind === "unknown") return right;
      // `==`/`!=` are deliberately loose here, per core.md §4.6's own semantics.
      const equal = node.operator.startsWith("=")
        ? node.operator === "==="
          ? left.value === right.value
          : left.value == right.value
        : node.operator === "!=="
          ? left.value !== right.value
          : left.value != right.value;
      return known(equal);
    }

    case "LogicalExpression": {
      if (!["&&", "||", "??"].includes(node.operator)) {
        return unknown(`unsupported logical operator: ${node.operator}`);
      }
      const left = evaluate(node.left, env);
      if (left.kind === "unknown") return left;
      const leftTruthy =
        node.operator === "??"
          ? left.value !== null && left.value !== undefined
          : Boolean(left.value);
      if (node.operator === "&&" && !leftTruthy) return left;
      if (node.operator === "||" && leftTruthy) return left;
      if (node.operator === "??" && leftTruthy) return left;
      return evaluate(node.right, env);
    }

    case "ConditionalExpression": {
      const test = evaluate(node.test, env);
      if (test.kind === "unknown") return test;
      return evaluate(test.value ? node.consequent : node.alternate, env);
    }

    default:
      return unknown(`unsupported expression kind: ${node.type}`);
  }
}

function isLiteralOrNull(node: any): boolean {
  return (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral" ||
    (node.type === "Identifier" && node.name === "undefined")
  );
}

function resolveAccessPathOrUnknown(node: any, env: EvalEnv): EvaluationResult {
  const accessPath = toAccessPath(node);
  if (!accessPath)
    return unknown("not a resolvable identifier/property-access chain");
  const value = env.resolveDecisionValue(accessPath.root, accessPath.path);
  if (
    typeof value === "object" &&
    value !== null &&
    "found" in value &&
    value.found === false
  ) {
    return unknown(
      `no decision registered for ${accessPath.root}.${accessPath.path.join(".")}`,
    );
  }
  return known(value as JsonPrimitive);
}

// ---------------------------------------------------------------------------
// Predicate decision + unknown fallback (core.md §4.6, "Predicate decision"
// and "Unknown fallback (unified rule)" paragraphs).
// ---------------------------------------------------------------------------

/**
 * Whether an AST node is side-effect-free per core.md §4.6's supported
 * subset (no calls, no assignment/update, no `await`). This governs whether
 * an otherwise-unevaluable boolean-shaped expression may be promoted to an
 * auxiliary predicate decision, rather than immediately falling back to a
 * dummy value.
 */
export function isSideEffectFree(node: any): boolean {
  if (!node) return true;
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "Identifier":
      return true;
    case "MemberExpression":
    case "OptionalMemberExpression":
      return !node.computed && isSideEffectFree(node.object);
    case "UnaryExpression":
      return node.operator === "!" && isSideEffectFree(node.argument);
    case "BinaryExpression":
      return isSideEffectFree(node.left) && isSideEffectFree(node.right);
    case "LogicalExpression":
      return isSideEffectFree(node.left) && isSideEffectFree(node.right);
    case "ConditionalExpression":
      return (
        isSideEffectFree(node.test) &&
        isSideEffectFree(node.consequent) &&
        isSideEffectFree(node.alternate)
      );
    default:
      return false; // CallExpression, AssignmentExpression, AwaitExpression, UpdateExpression, ...
  }
}

/**
 * Normalizes an expression to a stable string key for predicate-decision
 * correlation, treating `!x` as the negation of `x`'s own key (core.md
 * §4.6: "its simple negation (`!x`)").
 */
export function normalizePredicateKey(node: any): {
  key: string;
  negated: boolean;
} {
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const inner = normalizePredicateKey(node.argument);
    return { key: inner.key, negated: !inner.negated };
  }
  return { key: JSON.stringify(stripLocations(node)), negated: false };
}

function stripLocations(node: any): any {
  if (Array.isArray(node)) return node.map(stripLocations);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (
      k === "loc" ||
      k === "start" ||
      k === "end" ||
      k === "extra" ||
      k === "comments"
    )
      continue;
    out[k] = stripLocations(v);
  }
  return out;
}

export type UnknownFallback =
  | { kind: "if-both-branches" }
  | { kind: "finite-union-candidates"; values: readonly JsonPrimitive[] }
  | { kind: "dummy-value"; reason: "expression-not-symbolically-evaluable" };

/**
 * core.md §4.6's "Unknown fallback (unified rule)": given that `evaluate()`
 * returned `unknown` for an expression at a given site, decide what to do.
 * `site: "if"` always generates both branches locally. `site: "v-bind"`
 * falls back to a finite union if the STATIC type domain (independent of
 * this specific expression's evaluability) offers one, else a dummy value.
 */
export function unknownFallback(
  site: "if" | "v-bind",
  staticDomainValues: readonly JsonPrimitive[] | undefined,
): UnknownFallback {
  if (site === "if") return { kind: "if-both-branches" };
  if (staticDomainValues && staticDomainValues.length > 0) {
    return { kind: "finite-union-candidates", values: staticDomainValues };
  }
  return {
    kind: "dummy-value",
    reason: "expression-not-symbolically-evaluable",
  };
}
