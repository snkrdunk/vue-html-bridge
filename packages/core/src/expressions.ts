import ts from "typescript";
import type { JsonValue } from "./types.js";

export interface ExpressionEnvironment {
  resolve(path: string): { found: true; value: JsonValue } | { found: false };
  resolvePredicate(source: string): boolean | undefined;
}

export type EvaluationResult =
  | { kind: "known"; value: JsonValue | undefined }
  | { kind: "unknown"; reason: string };

export function parseExpression(source: string): ts.Expression | undefined {
  const file = ts.createSourceFile(
    "expression.ts",
    `(${source})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  return unwrap(statement.expression);
}

export function evaluateExpression(
  source: string,
  environment: ExpressionEnvironment,
): EvaluationResult {
  const expression = parseExpression(source);
  if (!expression) return { kind: "unknown", reason: "parse-error" };
  const result = evaluate(expression, environment);
  if (result.kind === "unknown") {
    const predicate = environment.resolvePredicate(normalizeExpression(source));
    if (predicate !== undefined) return { kind: "known", value: predicate };
  }
  return result;
}

export function referencedPaths(source: string): readonly string[] {
  const root = parseExpression(source);
  if (!root) return [];
  const paths = new Set<string>();
  function visit(node: ts.Node): void {
    const path = accessPath(node);
    if (path && !isPartOfLongerAccess(node)) paths.add(path);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return [...paths].sort();
}

export function isSideEffectFreeExpression(source: string): boolean {
  const root = parseExpression(source);
  if (!root) return false;
  let safe = true;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        node.operator !== ts.SyntaxKind.ExclamationToken &&
        node.operator !== ts.SyntaxKind.PlusToken &&
        node.operator !== ts.SyntaxKind.MinusToken) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    ) {
      safe = false;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return safe;
}

export function normalizeExpression(source: string): string {
  return source.replace(/\s+/g, "").replace(/^!/, (match) => match);
}

function evaluate(
  node: ts.Expression,
  environment: ExpressionEnvironment,
): EvaluationResult {
  node = unwrap(node);
  if (ts.isStringLiteral(node)) return known(node.text);
  if (ts.isNumericLiteral(node)) return known(Number(node.text));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return known(true);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return known(false);
  if (node.kind === ts.SyntaxKind.NullKeyword) return known(null);
  if (ts.isIdentifier(node) && node.text === "undefined")
    return known(undefined);

  const path = accessPath(node);
  if (path) {
    const resolved = environment.resolve(path);
    return resolved.found
      ? known(resolved.value)
      : { kind: "unknown", reason: `unresolved:${path}` };
  }

  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluate(node.operand, environment);
    if (operand.kind === "unknown") return operand;
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      return known(!operand.value);
    }
    if (
      node.operator === ts.SyntaxKind.MinusToken &&
      typeof operand.value === "number"
    ) {
      return known(-operand.value);
    }
    if (
      node.operator === ts.SyntaxKind.PlusToken &&
      typeof operand.value === "number"
    ) {
      return known(operand.value);
    }
    return { kind: "unknown", reason: "unsupported-unary" };
  }

  if (ts.isConditionalExpression(node)) {
    const condition = evaluate(node.condition, environment);
    if (condition.kind === "unknown") return condition;
    return evaluate(
      condition.value ? node.whenTrue : node.whenFalse,
      environment,
    );
  }

  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left, environment);
    if (left.kind === "unknown") return left;
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken && !left.value)
      return left;
    if (kind === ts.SyntaxKind.BarBarToken && left.value) return left;
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken &&
      left.value !== null &&
      left.value !== undefined
    ) {
      return left;
    }
    const right = evaluate(node.right, environment);
    if (right.kind === "unknown") return right;
    switch (kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return right;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return known(left.value === right.value);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return known(left.value !== right.value);
      case ts.SyntaxKind.EqualsEqualsToken:
        return known(String(left.value) === String(right.value));
      case ts.SyntaxKind.ExclamationEqualsToken:
        return known(String(left.value) !== String(right.value));
      case ts.SyntaxKind.GreaterThanToken:
        return known(Number(left.value) > Number(right.value));
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return known(Number(left.value) >= Number(right.value));
      case ts.SyntaxKind.LessThanToken:
        return known(Number(left.value) < Number(right.value));
      case ts.SyntaxKind.LessThanEqualsToken:
        return known(Number(left.value) <= Number(right.value));
      default:
        return { kind: "unknown", reason: "unsupported-binary" };
    }
  }

  if (ts.isArrayLiteralExpression(node)) {
    const values: JsonValue[] = [];
    for (const element of node.elements) {
      const value = evaluate(element, environment);
      if (value.kind === "unknown" || value.value === undefined) return value;
      values.push(value.value);
    }
    return known(values);
  }

  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return { kind: "unknown", reason: "unsupported-object-member" };
      }
      const value = evaluate(property.initializer, environment);
      if (value.kind === "unknown" || value.value === undefined) return value;
      object[property.name.getText().replace(/^['"]|['"]$/g, "")] = value.value;
    }
    return known(object);
  }

  return { kind: "unknown", reason: `unsupported:${ts.SyntaxKind[node.kind]}` };
}

function accessPath(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base ? `${base}.${node.name.text}` : undefined;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const base = accessPath(node.expression);
    const argument = node.argumentExpression;
    if (!base) return undefined;
    if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
      return `${base}.${argument.text}`;
    }
  }
  return undefined;
}

function isPartOfLongerAccess(node: ts.Node): boolean {
  return Boolean(
    node.parent &&
    ((ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node) ||
      (ts.isElementAccessExpression(node.parent) &&
        node.parent.expression === node)),
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function known(value: JsonValue | undefined): EvaluationResult {
  return { kind: "known", value };
}
