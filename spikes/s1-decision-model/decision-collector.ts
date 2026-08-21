// Spike for ADR-0002 (core.md §4.2, §4.3): parses an SFC end to end, resolves
// its props' domains (prop-domain.ts), walks the compiled template AST, and
// matches each `v-if` condition / dynamic attribute / `v-for` source back to
// a resolved prop — producing a DecisionIdentity + Domain pair per core.md
// §4.2/§4.4, entirely from real `@vue/compiler-sfc` + `@vue/compiler-dom`
// output (no hand-rolled template parser).

import { compileTemplate, parse as parseSfc } from "@vue/compiler-sfc";
import { NodeTypes } from "@vue/compiler-core";
import type { TypeAnalysisFs } from "./type-analysis-context.js";
import {
  resolvePropsDomain,
  type Domain,
  type ResolvedProp,
} from "./prop-domain.js";

export interface DecisionIdentity {
  symbolKey: string;
  accessPath: readonly (string | number)[];
}

export interface CollectedDecision {
  identity: DecisionIdentity;
  domain: Domain;
  /** Where in the template this particular reference was found, for reporting. */
  site: "v-if" | "v-bind" | "v-for-source" | "ternary-condition";
  expressionContent: string;
}

interface RootExpr {
  root: string;
  path: (string | number)[];
}

/**
 * Reduces a babel MemberExpression/Identifier AST (as produced on
 * `SimpleExpressionNode.ast` when compiling with `prefixIdentifiers: true`)
 * to a root identifier + property-access path. Returns undefined for
 * anything not a plain identifier/property-access chain (calls, binary
 * expressions, etc. are handled by the expression evaluator spike instead —
 * see expression-evaluation-table.ts).
 */
function toAccessPath(node: any): RootExpr | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") {
    // Vue rewrites resolved identifiers' `name` to a prefixed form
    // (e.g. "$setup.props") but preserves the original spelling in
    // `loc.identifierName` — that's the one we want for path building.
    const original: string = node.loc?.identifierName ?? node.name;
    return { root: original, path: [] };
  }
  if (node.type === "MemberExpression" && !node.computed) {
    const base = toAccessPath(node.object);
    if (!base) return undefined;
    return { root: base.root, path: [...base.path, node.property.name] };
  }
  if (node.type === "MemberExpression" && node.computed) {
    const base = toAccessPath(node.object);
    if (!base) return undefined;
    if (
      node.property.type === "StringLiteral" ||
      node.property.type === "NumericLiteral"
    ) {
      return { root: base.root, path: [...base.path, node.property.value] };
    }
    return undefined; // dynamic key we can't statically resolve — spike scope stops here.
  }
  return undefined;
}

export interface CollectResult {
  decisions: CollectedDecision[];
  /** Expressions we saw but couldn't reduce to a resolved-prop access path — for the evaluator table's "unknown fallback" cases. */
  unresolved: { site: string; content: string }[];
  resolvedProps: ResolvedProp[];
  filename: string;
}

export function collectDecisions(
  filename: string,
  source: string,
  propsTypeArgFinder: (scriptSetupContent: string) => any,
  fs: TypeAnalysisFs,
): CollectResult {
  const { descriptor } = parseSfc(source, { filename });
  if (!descriptor.scriptSetup) {
    throw new Error(`spike scope: ${filename} has no <script setup> block`);
  }
  const scriptSetupSource = descriptor.scriptSetup.content;
  const propsTypeArgNode = propsTypeArgFinder(scriptSetupSource);

  const resolvedProps = propsTypeArgNode
    ? resolvePropsDomain(filename, scriptSetupSource, propsTypeArgNode, fs)
    : [];
  const propsByName = new Map(resolvedProps.map((p) => [p.name, p]));

  // BindingMetadata drives Vue's own template codegen; we reuse it exactly
  // as compileScript would, so we don't need to reimplement scope analysis.
  const bindings: Record<string, string> = { props: "setup-reactive-const" };
  for (const p of resolvedProps) bindings[p.name] = "props";

  if (!descriptor.template) {
    throw new Error(`spike scope: ${filename} has no <template> block`);
  }
  const tmpl = compileTemplate({
    source: descriptor.template.content,
    filename,
    id: "spike",
    compilerOptions: {
      bindingMetadata: bindings as any,
      prefixIdentifiers: true,
    },
  });
  if (tmpl.errors.length > 0) {
    throw new Error(
      `template compile errors for ${filename}: ${tmpl.errors.map(String).join("; ")}`,
    );
  }

  const decisions: CollectedDecision[] = [];
  const unresolved: { site: string; content: string }[] = [];
  const templateSource = descriptor.template.content;

  /**
   * Finding: with `prefixIdentifiers: true` (needed so `.ast` is populated —
   * see below), Vue compiles essentially every expression referencing a
   * script binding into a `CompoundExpressionNode`, which has NO `.content`
   * string field at all (only plain `SimpleExpressionNode` does). So
   * "expression text for humans" has to come from the original template
   * source range, not from a `.content` field — this matters for how core
   * reports `CoreDiagnostic.message` / decision `displayName` later.
   */
  function sliceSource(exp: any, node: any = exp.ast): string {
    if (!exp?.loc) return "<unknown>";
    const base = exp.loc.start.offset;
    if (typeof node?.start !== "number" || typeof exp.ast?.start !== "number") {
      return templateSource.slice(exp.loc.start.offset, exp.loc.end.offset);
    }
    // Finding: Vue sometimes wraps the expression text in `(...)` before
    // handing it to babel (e.g. ternaries get `extra.parenthesized: true`),
    // shifting every babel node's `start`/`end` by a constant relative to
    // the un-wrapped template source. Subtracting the *root* node's own
    // start cancels that constant shift for any descendant, wrapped or not.
    const rootStart = exp.ast.start;
    return templateSource.slice(
      base + (node.start - rootStart),
      base + (node.end - rootStart),
    );
  }

  function resolveExprToDecision(
    exprNode: any,
    site: CollectedDecision["site"],
    content: string,
  ) {
    const accessPath = exprNode?.ast ? toAccessPath(exprNode.ast) : undefined;
    if (
      !accessPath ||
      accessPath.root !== "props" ||
      accessPath.path.length === 0
    ) {
      unresolved.push({ site, content });
      return;
    }
    const propName = accessPath.path[0] as string;
    const prop = propsByName.get(propName);
    if (!prop) {
      unresolved.push({ site, content });
      return;
    }
    decisions.push({
      identity: {
        symbolKey: `${filename}#props.${propName}`,
        accessPath: accessPath.path,
      },
      domain: prop.domain,
      site,
      expressionContent: content,
    });
  }

  function walk(node: any) {
    if (!node) return;
    switch (node.type) {
      case NodeTypes.IF:
        for (const branch of node.branches) {
          if (branch.condition) {
            resolveExprToDecision(
              branch.condition,
              "v-if",
              sliceSource(branch.condition),
            );
          }
          for (const child of branch.children) walk(child);
        }
        return;
      case NodeTypes.FOR:
        resolveExprToDecision(
          node.source,
          "v-for-source",
          sliceSource(node.source),
        );
        for (const child of node.children) walk(child);
        return;
      case NodeTypes.ELEMENT:
        for (const prop of node.props ?? []) {
          if (
            prop.type === NodeTypes.DIRECTIVE &&
            prop.name === "bind" &&
            prop.exp
          ) {
            resolveExprToDecision(prop.exp, "v-bind", sliceSource(prop.exp));
            // A ternary directly inside a v-bind is also worth flagging
            // distinctly, since core.md §4.4 gives ternaries their own row.
            if (prop.exp.ast?.type === "ConditionalExpression") {
              resolveExprToDecision(
                { ast: prop.exp.ast.test },
                "ternary-condition",
                sliceSource(prop.exp, prop.exp.ast.test),
              );
            }
          }
        }
        for (const child of node.children ?? []) walk(child);
        return;
      default:
        for (const child of node.children ?? []) walk(child);
    }
  }
  walk(tmpl.ast);

  return { decisions, unresolved, resolvedProps, filename };
}
