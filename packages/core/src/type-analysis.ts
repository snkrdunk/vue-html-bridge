import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type {
  JsonValue,
  TypeAnalysisContext,
  TypeAnalysisFs,
} from "./types.js";

export type ValueDomain =
  | { kind: "finite"; values: readonly JsonValue[]; typeName: string }
  | { kind: "string"; typeName: string }
  | { kind: "number"; typeName: string }
  | { kind: "array"; typeName: string }
  | { kind: "unknown"; typeName?: string };

export interface BindingInfo {
  identity: string;
  displayName: string;
  domain: ValueDomain;
}

const diskFs: TypeAnalysisFs = {
  fileExists: existsSync,
  readFile(filename) {
    try {
      return readFileSync(filename, "utf8");
    } catch {
      return undefined;
    }
  },
};

export function createTypeAnalysisContext(
  fs: TypeAnalysisFs = diskFs,
): TypeAnalysisContext {
  let epoch = 0;
  return {
    fs,
    get epoch() {
      return epoch;
    },
    invalidate() {
      epoch += 1;
    },
  };
}

export function analyzeBindings(
  filename: string,
  script: string | undefined,
  context: TypeAnalysisContext | undefined,
): Map<string, BindingInfo> {
  const bindings = new Map<string, BindingInfo>();
  if (!script) return bindings;
  const fs = context?.fs ?? diskFs;
  const sourceFile = ts.createSourceFile(
    filename,
    script,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const resolver = new TypeResolver(filename, sourceFile, fs);

  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement)) {
      const propsCall = findDefinePropsCall(statement.expression);
      if (propsCall) {
        for (const [name, domain] of resolver.resolveProps(propsCall)) {
          bindings.set(name, {
            identity: `${filename}#props.${name}`,
            displayName: name,
            domain,
          });
        }
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const propsCall = findDefinePropsCall(declaration.initializer);
      if (propsCall) {
        const props = resolver.resolveProps(propsCall);
        for (const [name, domain] of props) {
          const identity = `${filename}#props.${name}`;
          bindings.set(name, { identity, displayName: name, domain });
          if (ts.isIdentifier(declaration.name)) {
            bindings.set(`${declaration.name.text}.${name}`, {
              identity,
              displayName: `${declaration.name.text}.${name}`,
              domain,
            });
          }
        }
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const propName = element.propertyName
              ? element.propertyName.getText(sourceFile)
              : element.name.text;
            const domain = props.get(propName);
            if (domain) {
              bindings.set(element.name.text, {
                identity: `${filename}#props.${propName}`,
                displayName: element.name.text,
                domain,
              });
            }
          }
        }
        continue;
      }

      if (ts.isIdentifier(declaration.name)) {
        const domain = declaration.type
          ? resolver.resolveType(declaration.type)
          : resolver.resolveInitializer(declaration.initializer);
        bindings.set(declaration.name.text, {
          identity: `${filename}#local.${declaration.name.text}@${declaration.pos}`,
          displayName: declaration.name.text,
          domain,
        });
      }
    }
  }
  return bindings;
}

function findDefinePropsCall(
  expression: ts.Expression | undefined,
): ts.CallExpression | undefined {
  if (!expression) return undefined;
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "defineProps"
  ) {
    return expression;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "withDefaults"
  ) {
    return findDefinePropsCall(expression.arguments[0]);
  }
  return undefined;
}

class TypeResolver {
  private readonly declarations = new Map<string, ts.Declaration>();
  private readonly imports = new Map<
    string,
    { imported: string; specifier: string }
  >();

  constructor(
    private readonly filename: string,
    private readonly sourceFile: ts.SourceFile,
    private readonly fs: TypeAnalysisFs,
  ) {
    for (const statement of sourceFile.statements) {
      if (
        (ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement)) &&
        statement.name
      ) {
        this.declarations.set(statement.name.text, statement);
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        for (const element of statement.importClause.namedBindings.elements) {
          this.imports.set(element.name.text, {
            imported: element.propertyName?.text ?? element.name.text,
            specifier: statement.moduleSpecifier.text,
          });
        }
      }
    }
  }

  resolveProps(call: ts.CallExpression): Map<string, ValueDomain> {
    const typeArgument = call.typeArguments?.[0];
    if (typeArgument) return this.resolveMembers(typeArgument, new Set());
    const argument = call.arguments[0];
    const result = new Map<string, ValueDomain>();
    if (argument && ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name
          .getText(this.sourceFile)
          .replace(/^['"]|['"]$/g, "");
        const text = property.initializer.getText(this.sourceFile);
        const domain = text.includes("Boolean")
          ? finite([true, false], "boolean")
          : text.includes("String")
            ? { kind: "string" as const, typeName: "string" }
            : text.includes("Number")
              ? { kind: "number" as const, typeName: "number" }
              : text.includes("Array")
                ? { kind: "array" as const, typeName: "array" }
                : { kind: "unknown" as const };
        result.set(name, domain);
      }
    }
    return result;
  }

  resolveType(node: ts.TypeNode, seen = new Set<string>()): ValueDomain {
    if (node.kind === ts.SyntaxKind.BooleanKeyword) {
      return finite([true, false], "boolean");
    }
    if (node.kind === ts.SyntaxKind.StringKeyword) {
      return { kind: "string", typeName: "string" };
    }
    if (node.kind === ts.SyntaxKind.NumberKeyword) {
      return { kind: "number", typeName: "number" };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return finite([null], "null");
    if (ts.isLiteralTypeNode(node)) {
      const value = literalValue(node.literal);
      return value === undefined
        ? { kind: "unknown" }
        : finite([value], typeof value);
    }
    if (ts.isUnionTypeNode(node)) {
      const values: JsonValue[] = [];
      for (const member of node.types) {
        if (member.kind === ts.SyntaxKind.UndefinedKeyword) {
          values.push(null);
          continue;
        }
        const domain = this.resolveType(member, seen);
        if (domain.kind !== "finite") return domain;
        values.push(...domain.values);
      }
      return finite(uniqueJson(values), node.getText(this.sourceFile));
    }
    if (ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) {
      return { kind: "array", typeName: node.getText(this.sourceFile) };
    }
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(this.sourceFile);
      if (name === "Array" || name === "ReadonlyArray") {
        return { kind: "array", typeName: node.getText(this.sourceFile) };
      }
      if (name === "Ref" && node.typeArguments?.[0]) {
        return this.resolveType(node.typeArguments[0], seen);
      }
      if (seen.has(name)) return { kind: "unknown", typeName: name };
      seen.add(name);
      const declaration = this.declarations.get(name);
      if (declaration && ts.isTypeAliasDeclaration(declaration)) {
        return this.resolveType(declaration.type, seen);
      }
      const imported = this.imports.get(name);
      if (imported) {
        const importedResolver = this.loadImported(imported.specifier);
        const importedDeclaration = importedResolver?.declarations.get(
          imported.imported,
        );
        if (
          importedDeclaration &&
          ts.isTypeAliasDeclaration(importedDeclaration)
        ) {
          return importedResolver!.resolveType(importedDeclaration.type, seen);
        }
      }
      return { kind: "unknown", typeName: name };
    }
    return { kind: "unknown", typeName: node.getText(this.sourceFile) };
  }

  resolveInitializer(expression: ts.Expression | undefined): ValueDomain {
    if (!expression) return { kind: "unknown" };
    if (ts.isCallExpression(expression) && expression.typeArguments?.[0]) {
      return this.resolveType(expression.typeArguments[0]);
    }
    const value = expressionLiteralValue(expression);
    return value === undefined
      ? { kind: "unknown" }
      : finite([value], typeof value);
  }

  private resolveMembers(
    node: ts.TypeNode,
    seen: Set<string>,
  ): Map<string, ValueDomain> {
    if (ts.isTypeLiteralNode(node)) return this.membersToMap(node.members);
    if (ts.isIntersectionTypeNode(node)) {
      const result = new Map<string, ValueDomain>();
      for (const member of node.types) {
        for (const [key, value] of this.resolveMembers(member, seen)) {
          result.set(key, value);
        }
      }
      return result;
    }
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(this.sourceFile);
      if (seen.has(name)) return new Map();
      seen.add(name);
      const declaration = this.declarations.get(name);
      if (declaration) return this.declarationMembers(declaration, seen);
      const imported = this.imports.get(name);
      if (imported) {
        const resolver = this.loadImported(imported.specifier);
        const importedDeclaration = resolver?.declarations.get(
          imported.imported,
        );
        if (resolver && importedDeclaration) {
          return resolver.declarationMembers(importedDeclaration, seen);
        }
      }
    }
    return new Map();
  }

  private declarationMembers(
    declaration: ts.Declaration,
    seen: Set<string>,
  ): Map<string, ValueDomain> {
    if (ts.isTypeAliasDeclaration(declaration)) {
      return this.resolveMembers(declaration.type, seen);
    }
    if (ts.isInterfaceDeclaration(declaration)) {
      const result = this.membersToMap(declaration.members);
      for (const clause of declaration.heritageClauses ?? []) {
        for (const type of clause.types) {
          const reference = ts.factory.createTypeReferenceNode(
            type.expression.getText(this.sourceFile),
            type.typeArguments,
          );
          for (const [key, value] of this.resolveMembers(reference, seen)) {
            if (!result.has(key)) result.set(key, value);
          }
        }
      }
      return result;
    }
    return new Map();
  }

  private membersToMap(
    members: ts.NodeArray<ts.TypeElement>,
  ): Map<string, ValueDomain> {
    const result = new Map<string, ValueDomain>();
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name)
        continue;
      const name = member.name
        .getText(this.sourceFile)
        .replace(/^['"]|['"]$/g, "");
      const domain = this.resolveType(member.type);
      if (member.questionToken && domain.kind === "finite") {
        result.set(
          name,
          finite(uniqueJson([...domain.values, null]), domain.typeName),
        );
      } else {
        result.set(name, domain);
      }
    }
    return result;
  }

  private loadImported(specifier: string): TypeResolver | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const bare = specifier.replace(/\.(m|c)?js$/, "");
    const base = resolve(dirname(this.filename), bare);
    const filename = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      resolve(base, "index.ts"),
    ].find((candidate) => this.fs.fileExists(candidate));
    if (!filename) return undefined;
    const source = this.fs.readFile(filename);
    if (source === undefined) return undefined;
    return new TypeResolver(
      filename,
      ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true),
      this.fs,
    );
  }
}

function literalValue(
  node: ts.LiteralTypeNode["literal"],
): JsonValue | undefined {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  return undefined;
}

function expressionLiteralValue(
  expression: ts.Expression,
): JsonValue | undefined {
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
    return ts.isNumericLiteral(expression)
      ? Number(expression.text)
      : expression.text;
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

function finite(values: readonly JsonValue[], typeName: string): ValueDomain {
  return { kind: "finite", values, typeName };
}

function uniqueJson(values: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
