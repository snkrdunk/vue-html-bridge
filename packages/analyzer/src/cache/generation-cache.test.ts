import { describe, expect, it } from "vitest";
import type {
  GenerateOptions,
  GenerateResult,
  HtmlVariant,
} from "vue-html-bridge";
import {
  approximateGenerateResultBytes,
  generationCacheKey,
} from "./generation-cache.js";

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

describe("approximateGenerateResultBytes (analyzer.md §10.1/§10.3)", () => {
  const sourceRange = (filename: string) => ({ filename, start: 0, end: 1 });

  const baseVariant = (overrides: Partial<HtmlVariant> = {}): HtmlVariant => ({
    id: "v1",
    ordinal: 0,
    html: "<p>x</p>",
    decisions: [],
    map: [],
    ...overrides,
  });

  const baseResult = (variants: readonly HtmlVariant[]): GenerateResult => ({
    variants,
    diagnostics: [],
    stats: {
      decisionCount: 0,
      candidateCount: variants.length,
      emittedCount: variants.length,
      uniqueHtmlCount: variants.length,
      durationMs: 0,
      warningThresholdExceeded: false,
    },
  });

  it("counts a variant's decisions, not just its html and map (the exact field the original estimate silently dropped)", () => {
    const withoutDecisions = baseResult([baseVariant()]);
    const withDecisions = baseResult([
      baseVariant({
        decisions: [
          {
            decisionId: "d1",
            displayName: "Decision 1",
            value: "a fairly long literal value used for this decision",
          },
        ],
      }),
    ]);
    expect(approximateGenerateResultBytes(withDecisions)).toBeGreaterThan(
      approximateGenerateResultBytes(withoutDecisions),
    );
  });

  it("scales with a mapping entry's nested provenance/sourceRange payload, not a fixed per-entry guess", () => {
    const shortFilename = "/a.vue";
    const longFilename = `/workspace/${"segment/".repeat(50)}very-long-file.vue`;

    const resultFor = (filename: string): GenerateResult =>
      baseResult([
        baseVariant({
          map: [
            {
              generated: { start: 0, end: 1 },
              source: sourceRange(filename),
              kind: "text",
              provenance: {
                kind: "source-literal",
                sourceRange: sourceRange(filename),
              },
            },
          ],
        }),
      ]);

    expect(
      approximateGenerateResultBytes(resultFor(longFilename)),
    ).toBeGreaterThan(approximateGenerateResultBytes(resultFor(shortFilename)));
  });

  it("grows with variant count, so a file with a very large variant space is never mistaken for a small cache entry", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      baseVariant({ id: `v${i}`, html: "<p>x</p>".repeat(20) }),
    );
    expect(approximateGenerateResultBytes(baseResult(many))).toBeGreaterThan(
      approximateGenerateResultBytes(baseResult([baseVariant()])) * 100,
    );
  });
});
