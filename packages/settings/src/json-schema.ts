import { DEFAULT_SETTINGS } from "./defaults.js";
import { ATTRIBUTE_NAME_PATTERN, VALUE_PATH_PATTERN } from "./resolve.js";

/**
 * JSON-schema `pattern` for one `customDirectives` value template: either a
 * literal constant containing no `$value` occurrence, or the `$value`
 * dotted-path grammar. Editor-level hint only — `resolveSettings` performs
 * the authoritative validation (settings.md §3.1).
 */
const VALUE_TEMPLATE_JSON_PATTERN = `^(?:[^$]|\\$(?!value))*$|${VALUE_PATH_PATTERN.source}`;

/**
 * A minimal, hand-rolled JSON Schema value type — this package doesn't
 * depend on a JSON Schema library, and the schema it emits is small and
 * flat enough not to need one.
 */
export type JsonSchemaValue = Record<string, unknown>;

/**
 * Generates `schema.json` (settings.md §7): a JSON Schema for the *input*
 * form (`VueHtmlBridgeSettingsInput`), since that's what users write in
 * `.vue-html-bridge.json`. Field defaults are drawn from `DEFAULT_SETTINGS`
 * (defaults.ts, the §3.1 table) so the two can never drift silently.
 *
 * This is a pure function of `DEFAULT_SETTINGS`; the committed
 * `schema.json` at the package root is its output, pinned byte-for-byte by
 * the golden test in `json-schema.test.ts` (settings.md §8 item 9). Run
 * `pnpm run generate-schema` (after `pnpm run build`) to regenerate it
 * after an intentional schema change.
 */
export function generateSettingsJsonSchema(): JsonSchemaValue {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "vue-html-bridge settings",
    description:
      "Configuration shared by the vue-html-bridge language server and CLI (settings.md).",
    type: "object",
    properties: {
      $schema: {
        type: "string",
        description:
          "A JSON Schema reference for editor tooling; not itself a bridge setting.",
      },
      version: {
        description: "Reserved for a future settings schema version.",
      },
      enabled: {
        type: "boolean",
        default: DEFAULT_SETTINGS.enabled,
        description: "Whether the bridge analyzes this workspace at all.",
      },
      include: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        default: DEFAULT_SETTINGS.include,
        description: "Glob patterns for `.vue` files to analyze.",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        default: DEFAULT_SETTINGS.exclude,
        description: "Glob patterns to exclude from analysis.",
      },
      validateOnChange: {
        type: "boolean",
        default: DEFAULT_SETTINGS.validateOnChange,
        description:
          "Editor-session only (ignored by one-shot hosts): revalidate as the document changes.",
      },
      validateOnSave: {
        type: "boolean",
        default: DEFAULT_SETTINGS.validateOnSave,
        description:
          "Editor-session only (ignored by one-shot hosts): revalidate when the document is saved.",
      },
      debounceMs: {
        type: "integer",
        minimum: 0,
        maximum: 60000,
        default: DEFAULT_SETTINGS.debounceMs,
        description:
          "Editor-session only (ignored by one-shot hosts): debounce interval before revalidating.",
      },
      maxConcurrency: {
        type: "integer",
        minimum: 1,
        description:
          "Maximum concurrent validations. Omit to delegate to the analyzer's CPU-count-based default.",
      },
      warnVariantCount: {
        type: "integer",
        minimum: 1,
        description:
          "Variant count above which core reports a warning. Omit to delegate to core's default of 256.",
      },
      customElements: {
        type: "array",
        items: { type: "string" },
        default: DEFAULT_SETTINGS.customElements,
        description: "Tag names or globs treated as known custom elements.",
      },
      customDirectives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              pattern: "^[A-Za-z][\\w-]*$",
              description:
                'The directive name without "v-" (e.g. "src", "imgAttr"); matched camelized.',
            },
            attributes: {
              type: "object",
              propertyNames: { pattern: ATTRIBUTE_NAME_PATTERN.source },
              additionalProperties: {
                type: "string",
                pattern: VALUE_TEMPLATE_JSON_PATTERN,
              },
              description:
                'Attribute name -> value template: a literal string constant, or "$value" optionally followed by dotted property segments (e.g. "$value.src").',
            },
          },
          required: ["name", "attributes"],
          additionalProperties: false,
        },
        default: DEFAULT_SETTINGS.customDirectives,
        description:
          "Declares which attributes a custom directive sets and how to derive each value from the directive's bound expression.",
      },
      externalAdapters: {
        type: "string",
        enum: ["disabled", "trusted-workspace-only"],
        default: DEFAULT_SETTINGS.externalAdapters,
        description:
          "Whether adapters outside the bundled Markuplint adapter may be loaded.",
      },
      validators: {
        type: "array",
        items: {
          type: "object",
          properties: {
            adapter: {
              type: "string",
              minLength: 1,
              description:
                'The built-in adapter id (e.g. "markuplint") or an external adapter\'s npm package specifier.',
            },
            enabled: { type: "boolean", default: true },
            settings: {
              description: "Adapter-specific settings, opaque to this schema.",
            },
          },
          required: ["adapter"],
          additionalProperties: false,
        },
        default: DEFAULT_SETTINGS.validators,
        description: "The configured validator adapters, in order.",
      },
    },
    additionalProperties: false,
  };
}

/** `generateSettingsJsonSchema()`, serialized the way `schema.json` is committed: pretty-printed, trailing newline. */
export function serializeSettingsJsonSchema(): string {
  return `${JSON.stringify(generateSettingsJsonSchema(), null, 2)}\n`;
}
