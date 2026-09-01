import { describe, expect, it } from "vitest";
import type { GenerateOptions } from "vue-html-bridge";
import { generationCacheKey } from "./generation-cache.js";

const BASE = {
  source: "<template><p>x</p></template>",
  filename: "/workspace/A.vue",
  generateOptions: undefined,
  epoch: 0,
};

describe("generationCacheKey (analyzer.md §10.1)", () => {
  it("is identical for identical inputs", () => {
    expect(generationCacheKey(BASE)).toBe(generationCacheKey({ ...BASE }));
  });

  it("changes when the source content changes", () => {
    expect(generationCacheKey(BASE)).not.toBe(
      generationCacheKey({ ...BASE, source: "<template><p>y</p></template>" }),
    );
  });

  it("changes when the filename changes", () => {
    expect(generationCacheKey(BASE)).not.toBe(
      generationCacheKey({ ...BASE, filename: "/workspace/B.vue" }),
    );
  });

  it("is the same for a Windows-style backslash path and its forward-slash equivalent", () => {
    expect(
      generationCacheKey({ ...BASE, filename: "C:\\workspace\\A.vue" }),
    ).toBe(generationCacheKey({ ...BASE, filename: "C:/workspace/A.vue" }));
  });

  it("changes when the TypeScript project epoch changes", () => {
    expect(generationCacheKey(BASE)).not.toBe(
      generationCacheKey({ ...BASE, epoch: 1 }),
    );
  });

  it("changes when generateOptions changes, but not when semantically-empty options are reshaped", () => {
    expect(generationCacheKey(BASE)).not.toBe(
      generationCacheKey({
        ...BASE,
        generateOptions: { warnVariantCount: 10 },
      }),
    );
    // customElements order does not matter (normalized/sorted).
    expect(
      generationCacheKey({
        ...BASE,
        generateOptions: { customElements: ["b-el", "a-el"] },
      }),
    ).toBe(
      generationCacheKey({
        ...BASE,
        generateOptions: { customElements: ["a-el", "b-el"] },
      }),
    );
  });

  describe("customDirectives (plan.md §3)", () => {
    it("entry order, and each entry's attribute-key order, do not matter", () => {
      const forward: GenerateOptions = {
        customDirectives: [
          { name: "src", attributes: { src: "$value", alt: "icon" } },
          { name: "imgAttr", attributes: { height: "$value.h" } },
        ],
      };
      const reversedEverywhere: GenerateOptions = {
        customDirectives: [
          { name: "imgAttr", attributes: { height: "$value.h" } },
          { name: "src", attributes: { alt: "icon", src: "$value" } },
        ],
      };
      expect(generationCacheKey({ ...BASE, generateOptions: forward })).toBe(
        generationCacheKey({ ...BASE, generateOptions: reversedEverywhere }),
      );
    });

    it("changes the key when a mapping's attributes differ", () => {
      const a: GenerateOptions = {
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      };
      const b: GenerateOptions = {
        customDirectives: [{ name: "src", attributes: { src: "$value.url" } }],
      };
      expect(generationCacheKey({ ...BASE, generateOptions: a })).not.toBe(
        generationCacheKey({ ...BASE, generateOptions: b }),
      );
    });

    it("changes the key when the declared directive name differs", () => {
      const a: GenerateOptions = {
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      };
      const b: GenerateOptions = {
        customDirectives: [{ name: "imgAttr", attributes: { src: "$value" } }],
      };
      expect(generationCacheKey({ ...BASE, generateOptions: a })).not.toBe(
        generationCacheKey({ ...BASE, generateOptions: b }),
      );
    });

    it("treats absent and explicitly-empty customDirectives identically, same as customElements already does", () => {
      expect(generationCacheKey({ ...BASE, generateOptions: {} })).toBe(
        generationCacheKey({
          ...BASE,
          generateOptions: { customDirectives: [] },
        }),
      );
    });
  });
});

/** Forces an object literal to have exactly `keyof T`'s keys — same idiom as settings' `contract.test.ts`. */
type KeysRecord<T> = { [K in keyof T]-?: true };

/**
 * A forward-looking guard against the exact class of bug §3 fixes: pins the
 * key list of `GenerateOptions` exhaustively (a future field added there
 * without extending `keys` below fails to typecheck), then asserts that two
 * `generationCacheKey` calls differing only in that field produce different
 * keys (a future field added to `keys` but never wired into
 * `normalizeGenerateOptions` fails this test at runtime instead of silently
 * colliding cache keys in production).
 */
describe("generationCacheKey: exhaustive GenerateOptions field coverage (plan.md §3)", () => {
  const keys: KeysRecord<GenerateOptions> = {
    warnVariantCount: true,
    customElements: true,
    customDirectives: true,
  };

  const distinguishingValue: {
    [K in keyof GenerateOptions]-?: NonNullable<GenerateOptions[K]>;
  } = {
    warnVariantCount: 10,
    customElements: ["a-el"],
    customDirectives: [{ name: "src", attributes: { src: "$value" } }],
  };

  it.each(Object.keys(keys) as (keyof GenerateOptions)[])(
    "changes the cache key when %s differs, all else equal",
    (key) => {
      const a: GenerateOptions = {};
      const b: GenerateOptions = { [key]: distinguishingValue[key] };
      expect(generationCacheKey({ ...BASE, generateOptions: a })).not.toBe(
        generationCacheKey({ ...BASE, generateOptions: b }),
      );
    },
  );
});
