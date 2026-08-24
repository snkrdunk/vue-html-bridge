import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parse as parseTemplate } from "@vue/compiler-dom";
import {
  ElementTypes,
  NodeTypes,
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type ExpressionNode,
  type RootNode,
  type SimpleExpressionNode,
  type SourceLocation,
  type TemplateChildNode,
  type TextNode,
} from "@vue/compiler-core";
import { parse as parseSfc } from "@vue/compiler-sfc";
import {
  evaluateExpression,
  isSideEffectFreeExpression,
  normalizeExpression,
  referencedPaths,
  type ExpressionEnvironment,
} from "./expressions.js";
import {
  analyzeBindings,
  createTypeAnalysisContext,
  type BindingInfo,
} from "./type-analysis.js";
import type {
  CoreDiagnostic,
  DecisionAssignment,
  GenerateRequest,
  GenerateResult,
  GeneratedValueProvenance,
  HtmlVariant,
  JsonValue,
  MappingEntry,
  SourceRange,
} from "./types.js";

export { createTypeAnalysisContext };

interface Decision {
  id: string;
  identity: string;
  displayName: string;
  values: readonly JsonValue[];
}

/**
 * A v-for alias currently in scope while walking/rendering. `scopeId` ties
 * decisions derived from expressions that reference this alias to the FOR
 * node's own source range (core.md §4.2), so the same alias name used in
 * two different loops — or shadowing an outer binding of the same name —
 * never collapses into one decision.
 */
interface ForScope {
  alias: string;
  scopeId: string;
}

function rootIdentifier(path: string): string {
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

function isShadowed(path: string, scope: readonly ForScope[]): boolean {
  const root = rootIdentifier(path);
  return scope.some((frame) => frame.alias === root);
}

function enclosingScopeId(
  paths: readonly string[],
  scope: readonly ForScope[],
): string | undefined {
  for (let index = scope.length - 1; index >= 0; index -= 1) {
    const frame = scope[index]!;
    if (paths.some((path) => rootIdentifier(path) === frame.alias)) {
      return frame.scopeId;
    }
  }
  return undefined;
}

function cardinalityIdentity(
  bindings: ReadonlyMap<string, BindingInfo>,
  source: string,
  scope: readonly ForScope[],
): string {
  if (!isShadowed(source, scope)) {
    const binding = bindings.get(source);
    if (binding) return `${binding.identity}#cardinality`;
  }
  const scopeId = enclosingScopeId([source], scope);
  return scopeId
    ? `for:${scopeId}:${normalizeExpression(source)}#cardinality`
    : `for:${normalizeExpression(source)}#cardinality`;
}

function predicateIdentity(
  expression: string,
  scope: readonly ForScope[],
): string {
  const normalized = normalizePredicate(expression);
  const scopeId = enclosingScopeId(referencedPaths(normalized), scope);
  return scopeId
    ? `predicate:${scopeId}:${normalized}`
    : `predicate:${normalized}`;
}

interface Environment {
  values: Map<string, JsonValue>;
  assignments: DecisionAssignment[];
}

interface FragmentElement {
  kind: "element";
  tagName: string;
  tagRange: SourceRange;
  endTagRange?: SourceRange;
  attributes: FragmentAttribute[];
  children: Fragment[];
}

interface FragmentAttribute {
  name: string;
  value?: string;
  nameRange: SourceRange;
  valueRange?: SourceRange;
  provenance: GeneratedValueProvenance;
}

interface FragmentText {
  kind: "text";
  value: string;
  sourceRange: SourceRange;
  provenance: GeneratedValueProvenance;
}

type Fragment = FragmentElement | FragmentText;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

const ATTRIBUTE_BLOCKLIST = new Set([
  "key",
  "ref",
  "true-value",
  "false-value",
]);

export async function generateVariants(
  request: GenerateRequest,
): Promise<GenerateResult> {
  const started = performance.now();
  const signal = request.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const diagnostics: CoreDiagnostic[] = [];
  const parsed = parseSfc(request.source, { filename: request.filename });
  for (const error of parsed.errors) {
    diagnostics.push(
      diagnosticFromCompilerError(request.filename, error, "sfc-parse-error"),
    );
  }
  const template = parsed.descriptor.template;
  if (!template) {
    diagnostics.push({
      code: "missing-template",
      severity: "error",
      message: "The SFC has no <template> block.",
      sourceRange: range(request.filename, 0, 0),
    });
    return emptyResult(started, diagnostics);
  }
  const templateRange = range(
    request.filename,
    template.loc.start.offset,
    template.loc.end.offset,
  );
  if (template.lang || template.src) {
    diagnostics.push({
      code: "unsupported-template-source",
      severity: "error",
      message: template.src
        ? "<template src> is not supported."
        : `Template language ${template.lang ?? "unknown"} is not supported.`,
      sourceRange: templateRange,
    });
    return emptyResult(started, diagnostics, templateRange);
  }

  await yieldToEventLoop(signal);
  let root: RootNode | undefined;
  const templateErrors: unknown[] = [];
  try {
    root = parseTemplate(template.content, {
      comments: true,
      onError(error) {
        templateErrors.push(error);
      },
    });
  } catch (error) {
    templateErrors.push(error);
  }
  for (const error of templateErrors) {
    diagnostics.push(
      diagnosticFromCompilerError(
        request.filename,
        error,
        "template-parse-error",
        template.loc.start.offset,
      ),
    );
  }
  if (!root) return emptyResult(started, diagnostics, templateRange);

  const scriptBlock = parsed.descriptor.scriptSetup;
  if (parsed.descriptor.script?.src || parsed.descriptor.scriptSetup?.src) {
    diagnostics.push({
      code: "script-type-analysis-unavailable",
      severity: "warning",
      message:
        "Script src is not resolved; template expressions use conservative values.",
      sourceRange: templateRange,
    });
  } else if (parsed.descriptor.script && !scriptBlock) {
    diagnostics.push({
      code: "script-type-analysis-unavailable",
      severity: "info",
      message:
        "Options API and non-setup script bindings are not type-resolved; template expressions use conservative values.",
      sourceRange: templateRange,
    });
  }
  const bindings = analyzeBindings(
    request.filename,
    scriptBlock?.content,
    request.typeContext,
  );
  signal.throwIfAborted();
  const collector = new DecisionCollector(
    request.filename,
    template.loc.start.offset,
    bindings,
  );
  collector.walk(root);
  diagnostics.push(...collector.diagnostics);
  const decisions = collector.decisions;
  const environments = enumerate(decisions);
  const warningThreshold = request.options?.warnVariantCount ?? 256;
  const warningThresholdExceeded = environments.length > warningThreshold;
  if (warningThresholdExceeded) {
    diagnostics.push({
      code: "large-variant-space",
      severity: "warning",
      message: `This template produces ${environments.length} variants, exceeding the warning threshold of ${warningThreshold}.`,
      sourceRange: templateRange,
    });
  }

  const variants: HtmlVariant[] = [];
  let lastYield = performance.now();
  for (const [ordinal, environment] of environments.entries()) {
    signal.throwIfAborted();
    if (performance.now() - lastYield >= 8) {
      await yieldToEventLoop(signal);
      lastYield = performance.now();
    }
    const renderer = new Renderer({
      filename: request.filename,
      templateOffset: template.loc.start.offset,
      bindings,
      decisions,
      environment,
      diagnostics,
      customElements: request.options?.customElements ?? [],
    });
    const fragments = renderer.renderChildren(root.children);
    const serialized = serialize(fragments);
    variants.push({
      id: variantId(environment.assignments),
      ordinal,
      html: serialized.html,
      decisions: environment.assignments,
      map: serialized.map,
    });
  }
  const uniqueDiagnostics = deduplicateDiagnostics(diagnostics);
  return {
    variants,
    diagnostics: uniqueDiagnostics,
    templateRange,
    stats: {
      decisionCount: decisions.length,
      candidateCount: environments.length,
      emittedCount: variants.length,
      uniqueHtmlCount: new Set(variants.map((variant) => variant.html)).size,
      durationMs: performance.now() - started,
      warningThresholdExceeded,
    },
  };
}

class DecisionCollector {
  readonly decisions: Decision[] = [];
  readonly diagnostics: CoreDiagnostic[] = [];
  private readonly byIdentity = new Map<string, Decision>();

  constructor(
    private readonly filename: string,
    private readonly templateOffset: number,
    private readonly bindings: ReadonlyMap<string, BindingInfo>,
  ) {}

  walk(
    node: RootNode | TemplateChildNode,
    scope: readonly ForScope[] = [],
  ): void {
    let ownScope = scope;
    if (node.type === NodeTypes.ELEMENT) {
      const forDirective = directive(node, "for");
      const forExpression = expressionContent(forDirective?.exp);
      const parsedFor = forExpression ? parseFor(forExpression) : undefined;
      if (parsedFor) {
        this.addCardinality(parsedFor.source, scope);
        ownScope = [
          ...scope,
          { alias: parsedFor.alias, scopeId: `for:${node.loc.start.offset}` },
        ];
      }
      for (const prop of node.props) {
        if (prop.type !== NodeTypes.DIRECTIVE || prop.name === "for") continue;
        const expression = expressionContent(prop.exp);
        // Vue 3: when v-if sits on the same element as v-for, v-if is
        // evaluated OUTSIDE the loop and cannot see its alias — only the
        // node's other directives and its children can (core.md §5.3).
        const isIfLike = prop.name === "if" || prop.name === "else-if";
        const propScope = isIfLike ? scope : ownScope;
        if (expression && isIfLike) {
          this.addExpression(expression, true, prop.exp!, propScope);
        } else if (expression && ["bind", "model"].includes(prop.name)) {
          this.addExpression(expression, false, prop.exp!, propScope);
        }
        if (prop.name === "bind" && prop.arg) {
          const arg = asSimpleExpression(prop.arg);
          if (arg && !arg.isStatic) {
            this.addExpression(arg.content, false, prop.arg, propScope);
          }
        }
      }
      if (node.tag === "Suspense") {
        this.addDecision(
          `suspense:${node.loc.start.offset}`,
          `Suspense@${node.loc.start.offset}`,
          ["default", "fallback"],
        );
      }
    }
    for (const child of childrenOf(node)) this.walk(child, ownScope);
  }

  private addExpression(
    expression: string,
    booleanSite: boolean,
    loc: ExpressionNode,
    scope: readonly ForScope[],
  ): void {
    let added = false;
    for (const path of referencedPaths(expression)) {
      if (isShadowed(path, scope)) continue;
      if (path.endsWith(".length")) {
        const base = path.slice(0, -".length".length);
        const baseBinding = isShadowed(base, scope)
          ? undefined
          : this.bindings.get(base);
        if (baseBinding?.domain.kind === "array") {
          this.addCardinality(base, scope);
          added = true;
        }
        continue;
      }
      const binding = this.bindings.get(path);
      if (!binding) continue;
      if (binding.domain.kind === "finite") {
        this.addDecision(
          binding.identity,
          binding.displayName,
          binding.domain.values,
        );
        added = true;
      }
    }
    if (booleanSite && !added && isSideEffectFreeExpression(expression)) {
      const identity = predicateIdentity(expression, scope);
      this.addDecision(identity, expression, [true, false]);
    } else if (booleanSite && !added) {
      this.diagnostics.push({
        code: "expression-not-symbolically-evaluable",
        severity: "warning",
        message: `Expression cannot be evaluated without running JavaScript: ${expression}`,
        sourceRange: this.sourceRange(loc),
      });
      this.addDecision(`local-predicate:${loc.loc.start.offset}`, expression, [
        true,
        false,
      ]);
    }
  }

  private addCardinality(path: string, scope: readonly ForScope[]): void {
    const identity = cardinalityIdentity(this.bindings, path, scope);
    this.addDecision(identity, `${path}.length`, [0, 1, 2]);
  }

  private addDecision(
    identity: string,
    displayName: string,
    values: readonly JsonValue[],
  ): Decision {
    const existing = this.byIdentity.get(identity);
    if (existing) return existing;
    const decision: Decision = {
      id: `d-${hash(identity).slice(0, 12)}`,
      identity,
      displayName,
      values,
    };
    this.byIdentity.set(identity, decision);
    this.decisions.push(decision);
    return decision;
  }

  private sourceRange(node: ExpressionNode): SourceRange {
    return range(
      this.filename,
      this.templateOffset + node.loc.start.offset,
      this.templateOffset + node.loc.end.offset,
    );
  }
}

interface RendererOptions {
  filename: string;
  templateOffset: number;
  bindings: ReadonlyMap<string, BindingInfo>;
  decisions: readonly Decision[];
  environment: Environment;
  diagnostics: CoreDiagnostic[];
  customElements: readonly string[];
}

class Renderer {
  private readonly decisionsByIdentity: Map<string, Decision>;

  constructor(private readonly options: RendererOptions) {
    this.decisionsByIdentity = new Map(
      options.decisions.map((decision) => [decision.identity, decision]),
    );
  }

  renderChildren(
    nodes: readonly TemplateChildNode[],
    scope: readonly ForScope[] = [],
  ): Fragment[] {
    const result: Fragment[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node?.type === NodeTypes.COMMENT) continue;
      if (node?.type === NodeTypes.ELEMENT && directive(node, "if")) {
        const chain: ElementNode[] = [node];
        let cursor = index + 1;
        while (cursor < nodes.length) {
          const candidate = nodes[cursor];
          if (
            isIgnorableWhitespace(candidate) ||
            candidate?.type === NodeTypes.COMMENT
          ) {
            cursor += 1;
            continue;
          }
          if (
            candidate?.type === NodeTypes.ELEMENT &&
            (directive(candidate, "else-if") || directive(candidate, "else"))
          ) {
            chain.push(candidate);
            cursor += 1;
            continue;
          }
          break;
        }
        const selected = chain.find((branch) => {
          const expNode =
            directive(branch, "if")?.exp ?? directive(branch, "else-if")?.exp;
          const condition = expressionContent(expNode);
          return (
            condition === undefined ||
            this.truthy(condition, scope, expNode!.loc.start.offset)
          );
        });
        if (selected)
          result.push(...this.renderNode(selected, { skipIf: true }, scope));
        index = cursor - 1;
        continue;
      }
      if (
        node?.type === NodeTypes.ELEMENT &&
        (directive(node, "else-if") || directive(node, "else"))
      ) {
        continue;
      }
      result.push(...this.renderNode(node, {}, scope));
    }
    return result;
  }

  private renderNode(
    node: TemplateChildNode | undefined,
    state: { skipIf?: boolean; skipFor?: boolean } = {},
    scope: readonly ForScope[] = [],
  ): Fragment[] {
    if (!node) return [];
    if (node.type === NodeTypes.TEXT) {
      const value = normalizeText(node.content);
      if (!value) return [];
      const sourceRange = this.sourceRange(node.loc);
      return [
        {
          kind: "text",
          value,
          sourceRange,
          provenance: { kind: "source-literal", sourceRange },
        },
      ];
    }
    if (node.type === NodeTypes.INTERPOLATION) {
      const sourceRange = this.sourceRange(node.content.loc ?? node.loc);
      return [
        {
          kind: "text",
          value: "dummy-string",
          sourceRange,
          provenance: {
            kind: "synthetic",
            sourceRange,
            transformation: "text-placeholder",
          },
        },
      ];
    }
    if (node.type !== NodeTypes.ELEMENT) return [];

    if (!state.skipFor) {
      const forDirective = directive(node, "for");
      if (forDirective) {
        const forExpression = expressionContent(forDirective.exp);
        if (forExpression) {
          const parsed = parseFor(forExpression);
          if (!parsed) {
            this.addDiagnostic(
              "unsupported-v-for",
              "Could not parse this v-for expression.",
              forDirective.loc,
            );
            return [];
          }
          const count = this.cardinality(parsed.source, scope);
          const ownScope = [
            ...scope,
            { alias: parsed.alias, scopeId: `for:${node.loc.start.offset}` },
          ];
          const output: Fragment[] = [];
          for (let index = 0; index < count; index += 1) {
            output.push(
              ...this.renderNode(node, { ...state, skipFor: true }, ownScope),
            );
          }
          return output;
        }
      }
    }

    if (!state.skipIf) {
      const ifDirective = directive(node, "if");
      const condition = expressionContent(ifDirective?.exp);
      if (
        condition &&
        !this.truthy(condition, scope, ifDirective!.exp!.loc.start.offset)
      ) {
        return [];
      }
    }

    const tag = node.tag;
    if (tag === "slot") return [];
    if (tag === "Suspense") return this.renderSuspense(node, scope);
    if (["Transition", "Teleport"].includes(tag)) {
      return this.renderChildren(unwrapDefaultSlot(node.children), scope);
    }
    if (tag === "TransitionGroup") {
      const wrapper = textContent(staticAttribute(node, "tag")?.value);
      if (!wrapper)
        return this.renderChildren(unwrapDefaultSlot(node.children), scope);
      return [
        this.renderElement(
          node,
          wrapper,
          unwrapDefaultSlot(node.children),
          scope,
        ),
      ];
    }
    if (tag === "template") return this.renderChildren(node.children, scope);

    const isVueIs = textContent(staticAttribute(node, "is")?.value)?.startsWith(
      "vue:",
    );
    const custom = matchesCustomElement(tag, this.options.customElements);
    const component =
      isVueIs ||
      (node.tagType === ElementTypes.COMPONENT && !custom) ||
      /^[A-Z]/.test(tag);
    if (component) return [];
    return [this.renderElement(node, tag, node.children, scope)];
  }

  private renderElement(
    node: ElementNode,
    tagName: string,
    children: readonly TemplateChildNode[],
    scope: readonly ForScope[],
  ): FragmentElement {
    const tagStart = node.loc.start.offset + 1;
    const tagRange = this.sourceRangeOffsets(
      tagStart,
      tagStart + node.tag.length,
    );
    const attributes = this.renderAttributes(node, scope);
    let renderedChildren = this.renderChildren(children, scope);
    const htmlDirective = directive(node, "html");
    const textDirective = directive(node, "text");
    if (htmlDirective) {
      renderedChildren = [];
      this.addDiagnostic(
        "v-html-content-not-analyzed",
        "Content injected with v-html cannot be statically validated.",
        htmlDirective.loc,
      );
    } else if (textDirective) {
      const sourceRange = this.sourceRange(
        textDirective.exp?.loc ?? textDirective.loc,
      );
      renderedChildren = [
        {
          kind: "text",
          value: "dummy-string",
          sourceRange,
          provenance: {
            kind: "synthetic",
            sourceRange,
            transformation: "text-placeholder",
          },
        },
      ];
    }
    const endSource = node.loc.source;
    const close = endSource.lastIndexOf(`</${node.tag}`);
    const endTagRange =
      close >= 0
        ? this.sourceRangeOffsets(
            node.loc.start.offset + close + 2,
            node.loc.start.offset + close + 2 + node.tag.length,
          )
        : undefined;
    return {
      kind: "element",
      tagName,
      tagRange,
      endTagRange,
      attributes,
      children: renderedChildren,
    };
  }

  private renderAttributes(
    node: ElementNode,
    scope: readonly ForScope[],
  ): FragmentAttribute[] {
    const output: FragmentAttribute[] = [];
    const model = directive(node, "model");
    for (const prop of node.props) {
      if (prop.type === NodeTypes.ATTRIBUTE) {
        if (ATTRIBUTE_BLOCKLIST.has(prop.name) || prop.name === "tag") continue;
        if (model && ["value", "checked"].includes(prop.name)) {
          this.addDiagnostic(
            "v-model-static-attribute-conflict",
            `v-model overrides the static ${prop.name} attribute.`,
            prop.loc,
          );
          continue;
        }
        const nameRange = this.sourceRangeOffsets(
          prop.loc.start.offset,
          prop.loc.start.offset + prop.name.length,
        );
        const valueRange = prop.value
          ? sourceSubRange(
              this.options.filename,
              this.options.templateOffset,
              prop.loc,
              prop.value.content,
            )
          : undefined;
        output.push({
          name: prop.name,
          value: prop.value?.content,
          nameRange,
          valueRange,
          provenance: {
            kind: "source-literal",
            sourceRange: valueRange ?? nameRange,
          },
        });
        continue;
      }
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      if (
        [
          "if",
          "else-if",
          "else",
          "for",
          "show",
          "once",
          "memo",
          "cloak",
        ].includes(prop.name)
      ) {
        continue;
      }
      if (prop.name === "bind") {
        output.push(...this.renderBind(prop, scope));
      } else if (prop.name === "on") {
        output.push(this.renderEvent(prop));
      } else if (prop.name === "model") {
        const modelAttribute = this.renderModel(node, prop);
        if (modelAttribute) output.push(modelAttribute);
      } else if (!["text", "html", "slot", "pre"].includes(prop.name)) {
        this.addDiagnostic(
          "custom-directive-not-modeled",
          `The DOM effects of v-${prop.name} are not modeled.`,
          prop.loc,
        );
      }
    }
    return output.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.nameRange.start - right.nameRange.start,
    );
  }

  private renderBind(
    prop: DirectiveNode,
    scope: readonly ForScope[],
  ): FragmentAttribute[] {
    if (prop.modifiers.some((modifier) => modifier.content === "prop")) {
      return [];
    }
    const exp = asSimpleExpression(prop.exp);
    if (!exp?.content) return [];
    const evaluated = this.evaluate(exp.content, scope, exp.loc.start.offset);
    if (!prop.arg) {
      if (evaluated.kind !== "known" || !isJsonObject(evaluated.value)) {
        this.addDiagnostic(
          "object-v-bind-not-finite",
          "v-bind object keys and values could not be resolved to a finite object.",
          prop.loc,
        );
        return [];
      }
      return Object.entries(evaluated.value)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, value]) =>
          this.attributeFromValue(name, value, prop.loc, exp, scope),
        );
    }
    let name: string | undefined;
    const argExp = asSimpleExpression(prop.arg);
    if (argExp?.isStatic) name = argExp.content;
    else if (argExp) {
      const arg = this.evaluate(argExp.content, scope, argExp.loc.start.offset);
      if (arg.kind === "known" && typeof arg.value === "string")
        name = arg.value;
    }
    if (!name) {
      this.addDiagnostic(
        "dynamic-argument-not-finite",
        "The dynamic attribute name could not be narrowed to a finite value.",
        prop.arg.loc,
      );
      return [];
    }
    if (prop.modifiers.some((modifier) => modifier.content === "camel")) {
      name = name.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      );
    }
    if (ATTRIBUTE_BLOCKLIST.has(name)) return [];
    if (evaluated.kind === "known") {
      return this.attributeFromValue(
        name,
        evaluated.value,
        prop.arg.loc,
        exp,
        scope,
      );
    }
    const sourceRange = this.sourceRange(exp.loc);
    return [
      {
        name,
        value: dummyValue("", name),
        nameRange: this.sourceRange(prop.arg.loc),
        valueRange: sourceRange,
        provenance: {
          kind: "sentinel",
          sourceRange,
          reason: "unresolved-expression",
          originalType: this.expressionType(exp.content, scope),
        },
      },
    ];
  }

  private attributeFromValue(
    name: string,
    value: JsonValue | undefined,
    fallbackLoc: SourceLocation,
    valueNode: SimpleExpressionNode,
    scope: readonly ForScope[],
  ): FragmentAttribute[] {
    if (
      value === null ||
      value === undefined ||
      (value === false && BOOLEAN_ATTRIBUTES.has(name.toLowerCase()))
    ) {
      return [];
    }
    const valueRange = this.sourceRange(valueNode.loc ?? fallbackLoc);
    const provenance = this.provenanceForExpression(
      valueNode.content,
      valueRange,
      scope,
    );
    const stringValue =
      value === true && BOOLEAN_ATTRIBUTES.has(name.toLowerCase())
        ? undefined
        : formatAttributeValue(name, value);
    return [
      {
        name,
        value: stringValue,
        nameRange: this.sourceRange(fallbackLoc),
        valueRange,
        provenance,
      },
    ];
  }

  private renderEvent(prop: DirectiveNode): FragmentAttribute {
    const argExp = asSimpleExpression(prop.arg);
    const event = argExp?.isStatic ? argExp.content : "event";
    const sourceRange = this.sourceRange(prop.loc);
    return {
      name: `on${event.toLowerCase()}`,
      value: "dummy-fn",
      nameRange: prop.arg ? this.sourceRange(prop.arg.loc) : sourceRange,
      valueRange: prop.exp ? this.sourceRange(prop.exp.loc) : sourceRange,
      provenance: {
        kind: "synthetic",
        sourceRange,
        transformation: "vue-event",
      },
    };
  }

  private renderModel(
    node: ElementNode,
    prop: DirectiveNode,
  ): FragmentAttribute | undefined {
    const type = textContent(staticAttribute(node, "type")?.value);
    if (node.tag === "select") return undefined;
    const name =
      type && ["checkbox", "radio"].includes(type) ? "checked" : "value";
    const sourceRange = this.sourceRange(prop.exp?.loc ?? prop.loc);
    return {
      name,
      value: name === "checked" ? undefined : dummyValue(node.tag, name, type),
      nameRange: this.sourceRange(prop.loc),
      valueRange: sourceRange,
      provenance: {
        kind: "synthetic",
        sourceRange,
        transformation: "v-model",
      },
    };
  }

  private renderSuspense(
    node: ElementNode,
    scope: readonly ForScope[],
  ): Fragment[] {
    const decision = this.decisionsByIdentity.get(
      `suspense:${node.loc.start.offset}`,
    );
    const selected = decision
      ? this.options.environment.values.get(decision.id)
      : "default";
    const template = node.children.find((child) => {
      if (child.type !== NodeTypes.ELEMENT) return false;
      const slot = directive(child, "slot");
      return expressionContent(slot?.arg) === selected;
    });
    return template && template.type === NodeTypes.ELEMENT
      ? this.renderChildren(template.children, scope)
      : [];
  }

  private evaluate(
    expression: string,
    scope: readonly ForScope[],
    offset: number,
  ) {
    return evaluateExpression(
      expression,
      this.expressionEnvironment(scope, offset),
    );
  }

  private truthy(
    expression: string,
    scope: readonly ForScope[],
    offset: number,
  ): boolean {
    const result = this.evaluate(expression, scope, offset);
    return result.kind === "known" ? Boolean(result.value) : false;
  }

  private cardinality(source: string, scope: readonly ForScope[]): number {
    const identity = cardinalityIdentity(this.options.bindings, source, scope);
    const decision = this.decisionsByIdentity.get(identity);
    return Number(
      decision ? this.options.environment.values.get(decision.id) : 1,
    );
  }

  private expressionEnvironment(
    scope: readonly ForScope[],
    offset: number,
  ): ExpressionEnvironment {
    return {
      resolve: (path) => {
        if (isShadowed(path, scope)) return { found: false };
        if (path.endsWith(".length")) {
          const base = path.slice(0, -".length".length);
          if (!isShadowed(base, scope)) {
            const identity = cardinalityIdentity(
              this.options.bindings,
              base,
              scope,
            );
            const decision = this.decisionsByIdentity.get(identity);
            if (decision) {
              return {
                found: true,
                value: this.options.environment.values.get(decision.id) ?? 0,
              };
            }
          }
        }
        const binding = this.options.bindings.get(path);
        if (!binding) return { found: false };
        const decision = this.decisionsByIdentity.get(binding.identity);
        if (decision) {
          return {
            found: true,
            value: this.options.environment.values.get(decision.id) ?? null,
          };
        }
        return { found: false };
      },
      resolvePredicate: (source) => {
        const negated = source.startsWith("!");
        const identity = predicateIdentity(source, scope);
        const decision = this.decisionsByIdentity.get(identity);
        if (!decision) {
          const local = this.decisionsByIdentity.get(
            `local-predicate:${offset}`,
          );
          if (!local) return undefined;
          const value = Boolean(this.options.environment.values.get(local.id));
          return negated ? !value : value;
        }
        const value = Boolean(this.options.environment.values.get(decision.id));
        return negated ? !value : value;
      },
    };
  }

  private provenanceForExpression(
    expression: string,
    sourceRange: SourceRange,
    scope: readonly ForScope[],
  ): GeneratedValueProvenance {
    for (const path of referencedPaths(expression)) {
      if (isShadowed(path, scope)) continue;
      const binding = this.options.bindings.get(path);
      if (!binding) continue;
      const decision = this.decisionsByIdentity.get(binding.identity);
      if (decision) {
        return {
          kind: "finite-domain",
          sourceRange,
          decisionId: decision.id,
        };
      }
      if (["string", "number", "unknown"].includes(binding.domain.kind)) {
        return {
          kind: "sentinel",
          sourceRange,
          reason: "non-finite-type",
          originalType: binding.domain.typeName,
        };
      }
    }
    return { kind: "source-literal", sourceRange };
  }

  private expressionType(
    expression: string,
    scope: readonly ForScope[],
  ): string | undefined {
    for (const path of referencedPaths(expression)) {
      if (isShadowed(path, scope)) continue;
      const binding = this.options.bindings.get(path);
      if (binding) return binding.domain.typeName;
    }
    return undefined;
  }

  private addDiagnostic(
    code: string,
    message: string,
    loc: SourceLocation,
  ): void {
    this.options.diagnostics.push({
      code,
      severity: "warning",
      message,
      sourceRange: this.sourceRange(loc),
    });
  }

  private sourceRange(loc: SourceLocation): SourceRange {
    return this.sourceRangeOffsets(loc.start.offset, loc.end.offset);
  }

  private sourceRangeOffsets(start: number, end: number): SourceRange {
    return range(
      this.options.filename,
      this.options.templateOffset + start,
      this.options.templateOffset + end,
    );
  }
}

function serialize(fragments: readonly Fragment[]): {
  html: string;
  map: readonly MappingEntry[];
} {
  let html = "";
  const map: MappingEntry[] = [];
  const appendMapped = (
    value: string,
    source: SourceRange,
    kind: MappingEntry["kind"],
    provenance: GeneratedValueProvenance,
  ) => {
    const start = html.length;
    html += value;
    map.push({
      generated: { start, end: html.length },
      source,
      kind,
      provenance,
    });
  };
  const write = (fragment: Fragment): void => {
    if (fragment.kind === "text") {
      appendMapped(
        escapeText(fragment.value),
        fragment.sourceRange,
        "text",
        fragment.provenance,
      );
      return;
    }
    html += "<";
    appendMapped(fragment.tagName, fragment.tagRange, "element-name", {
      kind: "source-literal",
      sourceRange: fragment.tagRange,
    });
    for (const attribute of fragment.attributes) {
      html += " ";
      appendMapped(
        attribute.name,
        attribute.nameRange,
        "attribute-name",
        attribute.provenance,
      );
      if (attribute.value !== undefined) {
        html += '="';
        appendMapped(
          escapeAttribute(attribute.value),
          attribute.valueRange ?? attribute.nameRange,
          "attribute-value",
          attribute.provenance,
        );
        html += '"';
      }
    }
    html += ">";
    if (VOID_ELEMENTS.has(fragment.tagName.toLowerCase())) return;
    for (const child of fragment.children) write(child);
    html += "</";
    appendMapped(
      fragment.tagName,
      fragment.endTagRange ?? fragment.tagRange,
      "element-name",
      {
        kind: "source-literal",
        sourceRange: fragment.endTagRange ?? fragment.tagRange,
      },
    );
    html += ">";
  };
  for (const fragment of fragments) write(fragment);
  map.sort(
    (left, right) =>
      left.generated.start - right.generated.start ||
      left.generated.end -
        left.generated.start -
        (right.generated.end - right.generated.start) ||
      left.source.start - right.source.start,
  );
  return { html, map };
}

function enumerate(decisions: readonly Decision[]): Environment[] {
  let environments: Environment[] = [{ values: new Map(), assignments: [] }];
  for (const decision of decisions) {
    environments = environments.flatMap((environment) =>
      decision.values.map((value) => ({
        values: new Map(environment.values).set(decision.id, value),
        assignments: [
          ...environment.assignments,
          {
            decisionId: decision.id,
            displayName: decision.displayName,
            value,
          },
        ],
      })),
    );
  }
  return environments;
}

function childrenOf(
  node: RootNode | TemplateChildNode,
): readonly TemplateChildNode[] {
  return node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT
    ? node.children
    : [];
}

function asSimpleExpression(
  node: ExpressionNode | undefined,
): SimpleExpressionNode | undefined {
  return node?.type === NodeTypes.SIMPLE_EXPRESSION ? node : undefined;
}

function expressionContent(
  node: ExpressionNode | undefined,
): string | undefined {
  return asSimpleExpression(node)?.content;
}

function textContent(node: TextNode | undefined): string | undefined {
  return node?.content;
}

function directive(
  node: ElementNode | undefined,
  name: string,
): DirectiveNode | undefined {
  return node?.props.find(
    (prop): prop is DirectiveNode =>
      prop.type === NodeTypes.DIRECTIVE && prop.name === name,
  );
}

function staticAttribute(
  node: ElementNode | undefined,
  name: string,
): AttributeNode | undefined {
  return node?.props.find(
    (prop): prop is AttributeNode =>
      prop.type === NodeTypes.ATTRIBUTE && prop.name === name,
  );
}

function parseFor(
  expression: string,
): { alias: string; source: string } | undefined {
  const match = expression.match(
    /^\s*(?:\(([^,)]+)(?:,[^)]+)?\)|([^\s]+))\s+(?:in|of)\s+(.+)$/,
  );
  if (!match) return undefined;
  return {
    alias: (match[1] ?? match[2] ?? "item").trim(),
    source: (match[3] ?? "").trim(),
  };
}

function normalizePredicate(expression: string): string {
  return normalizeExpression(expression).replace(/^!/, "");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?|\n/g, " ");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n?|\n/g, "&#10;");
}

function formatAttributeValue(name: string, value: JsonValue): string {
  if (Array.isArray(value)) return value.map(String).join(" ");
  if (isJsonObject(value)) {
    if (name === "style") {
      return Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${key}:${String(item)}`)
        .join(";");
    }
    return Object.entries(value)
      .filter(([, item]) => Boolean(item))
      .map(([key]) => key)
      .sort()
      .join(" ");
  }
  return String(value);
}

function dummyValue(
  tag: string,
  attribute: string,
  inputType?: string,
): string {
  if (tag === "input" && attribute === "value") {
    if (inputType === "email") return "dummy@example.com";
    if (["number", "range"].includes(inputType ?? "")) return "1";
    if (inputType === "url") return "https://example.invalid/";
  }
  if (attribute === "id") return "dummy-id";
  return "dummy-string";
}

function sourceSubRange(
  filename: string,
  templateOffset: number,
  loc: SourceLocation,
  substring: string,
): SourceRange {
  const relative = loc.source.lastIndexOf(substring);
  const start = loc.start.offset + Math.max(0, relative);
  return range(
    filename,
    templateOffset + start,
    templateOffset + start + substring.length,
  );
}

function unwrapDefaultSlot(
  children: readonly TemplateChildNode[],
): readonly TemplateChildNode[] {
  const direct = children.find(
    (child) =>
      child.type === NodeTypes.ELEMENT &&
      expressionContent(directive(child, "slot")?.arg) === "default",
  );
  return direct && direct.type === NodeTypes.ELEMENT
    ? direct.children
    : children;
}

function isIgnorableWhitespace(node: TemplateChildNode | undefined): boolean {
  return node?.type === NodeTypes.TEXT && /^\s*$/.test(node.content);
}

function matchesCustomElement(
  tag: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(tag);
  });
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function range(filename: string, start: number, end: number): SourceRange {
  return { filename, start, end };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function variantId(assignments: readonly DecisionAssignment[]): string {
  return `v-${hash(JSON.stringify(assignments)).slice(0, 16)}`;
}

function deduplicateDiagnostics(
  diagnostics: readonly CoreDiagnostic[],
): CoreDiagnostic[] {
  const byKey = new Map<string, CoreDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.sourceRange.filename}:${diagnostic.sourceRange.start}:${diagnostic.sourceRange.end}`;
    if (!byKey.has(key)) byKey.set(key, diagnostic);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.sourceRange.start - right.sourceRange.start ||
      left.sourceRange.end - right.sourceRange.end ||
      left.code.localeCompare(right.code),
  );
}

function diagnosticFromCompilerError(
  filename: string,
  error: unknown,
  code: string,
  baseOffset = 0,
): CoreDiagnostic {
  const candidate = error as {
    message?: string;
    loc?: { start?: { offset?: number }; end?: { offset?: number } };
  };
  const start = baseOffset + (candidate.loc?.start?.offset ?? 0);
  const end = baseOffset + (candidate.loc?.end?.offset ?? start);
  return {
    code,
    severity: "error",
    message: candidate.message ?? String(error),
    sourceRange: range(filename, start, end),
  };
}

function emptyResult(
  started: number,
  diagnostics: readonly CoreDiagnostic[],
  templateRange?: SourceRange,
): GenerateResult {
  return {
    variants: [],
    diagnostics,
    templateRange,
    stats: {
      decisionCount: 0,
      candidateCount: 0,
      emittedCount: 0,
      uniqueHtmlCount: 0,
      durationMs: performance.now() - started,
      warningThresholdExceeded: false,
    },
  };
}

function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        signal.throwIfAborted();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
