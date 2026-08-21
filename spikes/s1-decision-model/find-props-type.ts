// Locates `defineProps<T>()`'s type argument node in a parsed `<script
// setup>` body. Narrow on purpose (spike scope, matches core.md's
// `<script setup lang="ts">` input-contract row) — the object-literal form
// of `defineProps({...})` and Options API `props` are explicitly out of
// scope for this spike (core.md §1 already routes those through the
// dummy-value fallback, no type resolution needed).

import { babelParse } from "@vue/compiler-sfc";

export function findPropsTypeArg(scriptSetupContent: string): any | undefined {
  const ast = babelParse(scriptSetupContent, {
    sourceType: "module",
    plugins: ["typescript"],
  }).program;

  let found: any | undefined;
  for (const stmt of ast.body) {
    const expr =
      stmt.type === "ExpressionStatement"
        ? stmt.expression
        : stmt.type === "VariableDeclaration"
          ? stmt.declarations[0]?.init
          : undefined;
    if (
      expr &&
      expr.type === "CallExpression" &&
      expr.callee.type === "Identifier" &&
      expr.callee.name === "defineProps" &&
      expr.typeParameters?.params?.[0]
    ) {
      found = expr.typeParameters.params[0];
    }
  }
  return found;
}
