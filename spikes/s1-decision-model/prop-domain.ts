// Spike for ADR-0002 (core.md §2, §4.4): resolves a `defineProps<T>()` type
// argument down to the finite domains core.md §4.4 needs (boolean, literal
// union, "attribute absent" via null/undefined, general/unsupported).
//
// Finding (see FINDINGS.md): `@vue/compiler-sfc`'s exported `resolveTypeElements`
// resolves the *outer* object shape (interface extends, cross-file `Props`
// type references) using its own private, version-coupled `TypeScope`/cache
// machinery — that part is worth reusing. But it hands back each property's
// *value* type unexpanded (a raw `TSTypeReference` for a local `type Status =
// "a" | "b"` alias, not the union itself), and Vue's own `inferRuntimeType`
// collapses that to a coarse runtime tag (`["String"]`), losing the literal
// values entirely. So this module reimplements the narrow remaining step —
// resolve a property's value type to a literal-union/boolean domain, walking
// local type aliases and same-directory type-only imports — deliberately
// small in scope, matching core.md §4.4's bounded needs (general string/number
// and anything else falls back to "unsupported", exactly like the design
// already requires for arbitrary expressions).

import { dirname, resolve as resolvePath } from "node:path";
import ts from "typescript";
import { babelParse, registerTS, resolveTypeElements } from "@vue/compiler-sfc";
import type { TypeAnalysisFs } from "./type-analysis-context.js";

registerTS(() => ts);

export type Domain =
  | { kind: "boolean" }
  | {
      kind: "literal-union";
      values: readonly (string | number | boolean)[];
      nullable: boolean;
    }
  | { kind: "array"; element: Domain }
  | { kind: "unsupported"; reason: string };

export interface ResolvedProp {
  name: string;
  optional: boolean;
  domain: Domain;
}

interface FileScope {
  filename: string;
  source: string;
  ast: any[]; // babel Statement[] — kept loose; this is spike code, not shipped.
}

const scopeCache = new Map<string, FileScope>();

function parseFileScope(filename: string, source: string): FileScope {
  const cached = scopeCache.get(filename);
  if (cached && cached.source === source) return cached;
  const ast = babelParse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  }).program.body;
  const scope: FileScope = { filename, source, ast };
  scopeCache.set(filename, scope);
  return scope;
}

/** Caller-driven invalidation — see TypeAnalysisContext.invalidate(). */
export function invalidateScope(filename: string): void {
  scopeCache.delete(filename);
}

function unwrapExport(stmt: any): any {
  return stmt.type === "ExportNamedDeclaration" && stmt.declaration
    ? stmt.declaration
    : stmt;
}

function findLocalTypeNode(scope: FileScope, name: string): any | undefined {
  for (const raw of scope.ast) {
    const stmt = unwrapExport(raw);
    if (stmt.type === "TSTypeAliasDeclaration" && stmt.id.name === name) {
      return stmt.typeAnnotation;
    }
    if (stmt.type === "TSInterfaceDeclaration" && stmt.id.name === name) {
      return stmt.body; // TSInterfaceBody — not walked further by this spike.
    }
  }
  return undefined;
}

function findImportSource(scope: FileScope, name: string): string | undefined {
  for (const stmt of scope.ast) {
    if (stmt.type !== "ImportDeclaration") continue;
    for (const spec of stmt.specifiers) {
      if (
        spec.type === "ImportSpecifier" &&
        (spec.imported.name ?? spec.imported.value) === name
      ) {
        return stmt.source.value;
      }
    }
  }
  return undefined;
}

function resolveModuleFile(
  fromFile: string,
  specifier: string,
  fs: TypeAnalysisFs,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // spike: no node_modules resolution
  // Finding: NodeNext-style import specifiers spell out a ".js" extension
  // (matching this repo's own tsconfig.base.json: module/moduleResolution:
  // NodeNext) even when the real file on disk is ".ts" — a real resolver
  // must strip that before extension-probing, not just append candidates.
  const withoutJsExt = specifier.replace(/\.(m|c)?js$/, "");
  const base = resolvePath(dirname(fromFile), withoutJsExt);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (fs.fileExists(candidate)) return candidate;
  }
  return undefined;
}

function loadFileScope(
  filename: string,
  fs: TypeAnalysisFs,
): FileScope | undefined {
  const source = fs.readFile(filename);
  if (source === undefined) return undefined;
  return parseFileScope(filename, source);
}

function literalValue(node: any): string | number | boolean | undefined {
  if (node.type !== "TSLiteralType") return undefined;
  const lit = node.literal;
  if (lit.type === "StringLiteral") return lit.value;
  if (lit.type === "NumericLiteral") return lit.value;
  if (lit.type === "BooleanLiteral") return lit.value;
  return undefined;
}

function resolveTypeNode(
  node: any,
  scope: FileScope,
  fs: TypeAnalysisFs,
  seen: Set<string>,
): Domain {
  switch (node.type) {
    case "TSBooleanKeyword":
      return { kind: "boolean" };
    case "TSLiteralType": {
      const value = literalValue(node);
      if (value === undefined) {
        return { kind: "unsupported", reason: `unsupported literal type` };
      }
      return { kind: "literal-union", values: [value], nullable: false };
    }
    case "TSParenthesizedType":
      return resolveTypeNode(node.typeAnnotation, scope, fs, seen);
    case "TSArrayType":
      return {
        kind: "array",
        element: resolveTypeNode(node.elementType, scope, fs, seen),
      };
    case "TSUnionType": {
      let nullable = false;
      const values: (string | number | boolean)[] = [];
      for (const member of node.types) {
        if (
          member.type === "TSNullKeyword" ||
          member.type === "TSUndefinedKeyword"
        ) {
          nullable = true;
          continue;
        }
        const sub = resolveTypeNode(member, scope, fs, seen);
        if (sub.kind === "literal-union") {
          values.push(...sub.values);
          nullable = nullable || sub.nullable;
        } else if (sub.kind === "boolean") {
          values.push(true, false);
        } else {
          return {
            kind: "unsupported",
            reason: `union member is not a finite literal (${member.type})`,
          };
        }
      }
      return { kind: "literal-union", values, nullable };
    }
    case "TSTypeReference": {
      const name =
        node.typeName.type === "Identifier" ? node.typeName.name : undefined;
      if (!name) {
        return { kind: "unsupported", reason: "qualified type reference" };
      }
      const cacheKey = `${scope.filename}#${name}`;
      if (seen.has(cacheKey)) {
        return {
          kind: "unsupported",
          reason: `circular type reference: ${name}`,
        };
      }
      seen.add(cacheKey);

      const local = findLocalTypeNode(scope, name);
      if (local) return resolveTypeNode(local, scope, fs, seen);

      const importSource = findImportSource(scope, name);
      if (importSource) {
        const resolvedFile = resolveModuleFile(
          scope.filename,
          importSource,
          fs,
        );
        if (resolvedFile) {
          const importedScope = loadFileScope(resolvedFile, fs);
          if (importedScope) {
            const importedNode = findLocalTypeNode(importedScope, name);
            if (importedNode) {
              return resolveTypeNode(importedNode, importedScope, fs, seen);
            }
          }
        }
      }
      return {
        kind: "unsupported",
        reason: `unresolved type reference: ${name}`,
      };
    }
    default:
      return {
        kind: "unsupported",
        reason: `unsupported type node kind: ${node.type}`,
      };
  }
}

/**
 * Given a parsed `<script setup>` and the `defineProps<T>()` type argument
 * node (already located in that file's AST), resolve each declared prop to a
 * `Domain`. `fs` is the caller-injected TypeAnalysisContext seam — cross-file
 * type imports are read through it, so an unsaved-buffer override is honored
 * for dependency files, not just the SFC's own script.
 */
export function resolvePropsDomain(
  filename: string,
  scriptSetupSource: string,
  propsTypeArgNode: any,
  fs: TypeAnalysisFs,
): ResolvedProp[] {
  const scope = parseFileScope(filename, scriptSetupSource);
  const ctx = {
    filename,
    source: scriptSetupSource,
    ast: scope.ast,
    // Finding: without this, `resolveTypeElements`'s internal `resolveFS()`
    // falls back to real `ts.sys` for any file it reads while resolving the
    // *outer* object shape (e.g. an imported `Props` interface) — silently
    // bypassing the caller-injected TypeAnalysisContext for that part of
    // resolution. Wiring `ctx.fs` through is what makes unsaved-buffer
    // overrides apply uniformly across both Vue's own resolver and this
    // module's supplementary literal-union walker.
    fs: {
      fileExists: (f: string) => fs.fileExists(f),
      readFile: (f: string) => fs.readFile(f),
    },
    options: {},
    isCE: false,
    error(msg: string): never {
      throw new Error(`[resolveType error] ${msg}`);
    },
    warn(_msg: string) {
      // Spike: swallow warnings — production code should route through
      // core's own CoreDiagnostic channel (core.md §8).
    },
    helper(name: string) {
      return name;
    },
    getString(node: any) {
      return scriptSetupSource.slice(node.start, node.end);
    },
  };

  const resolved = resolveTypeElements(ctx as any, propsTypeArgNode);
  const props: ResolvedProp[] = [];
  for (const [name, node] of Object.entries(resolved.props)) {
    const typeAnn = (node as any).typeAnnotation?.typeAnnotation;
    const ownerScope: FileScope = (node as any)._ownerScope
      ? {
          filename: (node as any)._ownerScope.filename,
          source: (node as any)._ownerScope.source,
          ast: scope.ast, // best-effort: same-file case is the common one exercised here.
        }
      : scope;
    const domain = typeAnn
      ? resolveTypeNode(typeAnn, ownerScope, fs, new Set())
      : { kind: "unsupported" as const, reason: "no type annotation" };
    props.push({ name, optional: Boolean((node as any).optional), domain });
  }
  return props;
}
