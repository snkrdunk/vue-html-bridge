import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  generateSettingsJsonSchema,
  serializeSettingsJsonSchema,
} from "./json-schema.js";

const schemaJsonPath = new URL("../schema.json", import.meta.url);

describe("generateSettingsJsonSchema", () => {
  it("describes the input form, keyed by DEFAULT_SETTINGS for every default", () => {
    const schema = generateSettingsJsonSchema();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);

    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.enabled?.default).toBe(DEFAULT_SETTINGS.enabled);
    expect(properties.include?.default).toEqual(DEFAULT_SETTINGS.include);
    expect(properties.exclude?.default).toEqual(DEFAULT_SETTINGS.exclude);
    expect(properties.debounceMs?.default).toBe(DEFAULT_SETTINGS.debounceMs);
    expect(properties.customElements?.default).toEqual(
      DEFAULT_SETTINGS.customElements,
    );
    expect(properties.externalAdapters?.default).toBe(
      DEFAULT_SETTINGS.externalAdapters,
    );
    expect(properties.validators?.default).toEqual(DEFAULT_SETTINGS.validators);

    // Delegated fields never have a `default` — the schema would then be
    // documenting a copy of another package's default (settings.md §3).
    expect(properties.maxConcurrency).not.toHaveProperty("default");
    expect(properties.warnVariantCount).not.toHaveProperty("default");

    // Reserved keys are accepted but unconstrained.
    expect(properties).toHaveProperty("$schema");
    expect(properties).toHaveProperty("version");
  });

  it("is deterministic across calls", () => {
    expect(serializeSettingsJsonSchema()).toBe(serializeSettingsJsonSchema());
  });
});

describe("schema.json golden (§8 item 9)", () => {
  it("regenerating produces byte-identical content to the committed schema.json", () => {
    const committed = readFileSync(schemaJsonPath, "utf8");
    expect(serializeSettingsJsonSchema()).toBe(committed);
  });

  it("committed schema.json parses as the same object generateSettingsJsonSchema() returns", () => {
    const committed = JSON.parse(
      readFileSync(schemaJsonPath, "utf8"),
    ) as unknown;
    expect(committed).toEqual(generateSettingsJsonSchema());
  });

  it("package.json declares the ./schema.json export pointing at the committed file", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(manifest.exports?.["./schema.json"]).toBe("./schema.json");
  });

  it("the @vue-html-bridge/settings/schema.json export path resolves and matches the committed file", () => {
    // No other package in this monorepo consumes @vue-html-bridge/settings
    // at runtime yet (this is the first consumer to exist), so this
    // exercises Node's own package self-reference resolution algorithm —
    // the identical mechanism a future consumer package would use to
    // resolve `@vue-html-bridge/settings/schema.json` — from within the
    // package itself.
    const resolved = import.meta
      .resolve("@vue-html-bridge/settings/schema.json");
    const resolvedPath = fileURLToPath(resolved);
    expect(resolvedPath).toBe(fileURLToPath(schemaJsonPath));
    expect(readFileSync(resolvedPath, "utf8")).toBe(
      readFileSync(schemaJsonPath, "utf8"),
    );
  });
});
