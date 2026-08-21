import { describe, expect, it } from "vitest";
import { findSourceOrigins, generateVariants } from "./index.js";

describe("generateVariants", () => {
  it("correlates a v-if and ternary attribute through one decision", async () => {
    const source = `<script setup lang="ts">
defineProps<{ loggedIn: boolean }>();
</script>
<template>
  <nav v-if="loggedIn" id="user-menu" />
  <button :aria-controls="loggedIn ? 'user-menu' : undefined" />
</template>`;
    const result = await generateVariants({ filename: "/p/Menu.vue", source });
    expect(result.variants).toHaveLength(2);
    expect(result.variants.map((variant) => variant.html)).toEqual([
      '<nav id="user-menu"></nav><button aria-controls="user-menu"></button>',
      "<button></button>",
    ]);
    expect(result.stats.decisionCount).toBe(1);
  });

  it("renders v-for with correlated 0, 1 and duplicate 2 exemplars", async () => {
    const source = `<script setup lang="ts">
defineProps<{ items: string[] }>();
</script>
<template><ul><li v-for="item in items" id="row">{{ item }}</li></ul></template>`;
    const result = await generateVariants({ filename: "/p/List.vue", source });
    expect(result.variants.map((variant) => variant.html)).toEqual([
      "<ul></ul>",
      '<ul><li id="row">dummy-string</li></ul>',
      '<ul><li id="row">dummy-string</li><li id="row">dummy-string</li></ul>',
    ]);
  });

  it("keeps sentinel and synthetic provenance at source expression ranges", async () => {
    const source = `<script setup lang="ts">defineProps<{ pressed: string }>();</script>
<template><button :aria-pressed="pressed" @click="save">Toggle</button></template>`;
    const result = await generateVariants({
      filename: "/p/Toggle.vue",
      source,
    });
    const variant = result.variants[0]!;
    expect(variant.html).toBe(
      '<button aria-pressed="dummy-string" onclick="dummy-fn">Toggle</button>',
    );
    expect(
      variant.map.find(
        (entry) =>
          entry.kind === "attribute-value" &&
          variant.html.slice(entry.generated.start, entry.generated.end) ===
            "dummy-string",
      )?.provenance,
    ).toMatchObject({ kind: "sentinel", originalType: "string" });
    expect(
      variant.map.find(
        (entry) =>
          entry.kind === "attribute-name" &&
          variant.html.slice(entry.generated.start, entry.generated.end) ===
            "onclick",
      )?.provenance,
    ).toMatchObject({ kind: "synthetic", transformation: "vue-event" });
  });

  it("serializes to one line, escapes attribute newlines and strips comments", async () => {
    const source = `<template><div title="a
b">a
<!-- hidden -->b &lt; c</div></template>`;
    const result = await generateVariants({ filename: "/p/A.vue", source });
    expect(result.variants[0]?.html).toBe(
      '<div title="a&#10;b">a b &lt; c</div>',
    );
    expect(result.variants[0]?.html).not.toContain("\n");
  });

  it("implements zero-width reverse lookup rules", () => {
    const entry = {
      generated: { start: 2, end: 5 },
      source: { filename: "A.vue", start: 10, end: 13 },
      kind: "text" as const,
      provenance: {
        kind: "source-literal" as const,
        sourceRange: { filename: "A.vue", start: 10, end: 13 },
      },
    };
    expect(findSourceOrigins([entry], { start: 3, end: 3 })).toEqual([
      { entry, overlap: 0 },
    ]);
    expect(findSourceOrigins([entry], { start: 5, end: 5 })).toEqual([
      { entry, overlap: 0 },
    ]);
    expect(findSourceOrigins([entry], { start: 6, end: 6 })).toEqual([]);
  });

  it("warns but emits every candidate and preserves cancellation", async () => {
    const source = `<script setup lang="ts">defineProps<{ a: boolean; b: boolean }>();</script>
<template><i v-if="a"></i><b v-if="b"></b></template>`;
    const result = await generateVariants({
      filename: "/p/A.vue",
      source,
      options: { warnVariantCount: 2 },
    });
    expect(result.variants).toHaveLength(4);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "large-variant-space" }),
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      generateVariants({
        filename: "/p/A.vue",
        source,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects template preprocessors without producing variants", async () => {
    const result = await generateVariants({
      filename: "/p/A.vue",
      source: '<template lang="pug">div Hello</template>',
    });
    expect(result.variants).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("unsupported-template-source");
  });
});
