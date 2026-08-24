import { describe, expect, it } from "vitest";
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
});
