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

  it("correlates v-for cardinality with a separate .length predicate over the same collection", async () => {
    const source = `<script setup lang="ts">
defineProps<{ items: string[] }>();
</script>
<template>
  <ul><li v-for="item in items">{{ item }}</li></ul>
  <p v-if="items.length > 0">has items</p>
</template>`;
    const result = await generateVariants({ filename: "/p/List.vue", source });
    // One shared decision drives both the loop and the predicate, so the
    // enumeration produces exactly 3 candidates, not 3*2 independent ones.
    expect(result.stats.decisionCount).toBe(1);
    expect(result.stats.candidateCount).toBe(3);
    expect(result.stats.uniqueHtmlCount).toBe(3);
    expect(result.variants.map((variant) => variant.html)).toEqual([
      "<ul></ul>",
      "<ul><li>dummy-string</li></ul><p>has items</p>",
      "<ul><li>dummy-string</li><li>dummy-string</li></ul><p>has items</p>",
    ]);
  });

  it("falls back to an independent predicate for a >2-style length comparison instead of always-false", async () => {
    const source = `<script setup lang="ts">
defineProps<{ items: string[] }>();
</script>
<template>
  <ul><li v-for="item in items">{{ item }}</li></ul>
  <p v-if="items.length > 2">many items</p>
</template>`;
    const result = await generateVariants({ filename: "/p/Many.vue", source });
    // Two independent decisions (cardinality + the fallback predicate), not
    // one shared decision that would make "many items" permanently
    // unreachable since cardinality never exceeds 2.
    expect(result.stats.decisionCount).toBe(2);
    expect(
      result.variants.some((variant) => variant.html.includes("many items")),
    ).toBe(true);
    expect(
      result.variants.some((variant) => !variant.html.includes("many items")),
    ).toBe(true);
  });

  it("scopes an expression referencing a v-for alias separately from an outer binding of the same name", async () => {
    const source = `<script setup lang="ts">
import { ref } from "vue";
const item = ref(true);
defineProps<{ items: string[] }>();
</script>
<template>
  <div v-if="item">outer</div>
  <ul><li v-for="item in items"><span v-if="item">{{ item }}</span></li></ul>
</template>`;
    const result = await generateVariants({
      filename: "/p/Shadow.vue",
      source,
    });
    // Three independent decisions: the outer "item" ref, the loop's own
    // cardinality, and the alias-scoped "item" inside the loop — the alias
    // must not be confused with the outer binding of the same name.
    expect(result.stats.decisionCount).toBe(3);
    const outerTrueCardOne = result.variants.find(
      (variant) =>
        variant.decisions[0]?.value === true &&
        variant.decisions[1]?.value === 1 &&
        variant.decisions[2]?.value === false,
    );
    expect(outerTrueCardOne?.html).toBe("<div>outer</div><ul><li></li></ul>");
    const outerFalseCardOneInnerTrue = result.variants.find(
      (variant) =>
        variant.decisions[0]?.value === false &&
        variant.decisions[1]?.value === 1 &&
        variant.decisions[2]?.value === true,
    );
    expect(outerFalseCardOneInnerTrue?.html).toBe(
      "<ul><li><span>dummy-string</span></li></ul>",
    );
  });

  it("keeps two different v-for loops using the same alias name as separate decisions", async () => {
    const source = `<script setup lang="ts">
defineProps<{ a: string[]; b: string[] }>();
</script>
<template>
  <ul><li v-for="item in a"><b v-if="item === 'x'">A</b></li></ul>
  <ol><li v-for="item in b"><b v-if="item === 'x'">B</b></li></ol>
</template>`;
    const result = await generateVariants({
      filename: "/p/TwoLoops.vue",
      source,
    });
    // Two cardinalities plus two independently scoped "item === 'x'"
    // predicates — the identical alias/expression text in each loop must
    // not collapse into one shared decision.
    expect(result.stats.decisionCount).toBe(4);
    const cardOneAInnerTrueBInnerFalse = result.variants.find(
      (variant) =>
        variant.decisions[0]?.value === 1 &&
        variant.decisions[1]?.value === true &&
        variant.decisions[2]?.value === 1 &&
        variant.decisions[3]?.value === false,
    );
    expect(cardOneAInnerTrueBInnerFalse?.html).toBe(
      "<ul><li><b>A</b></li></ul><ol><li></li></ol>",
    );
  });

  it("makes v-if / v-else-if / v-else mutually exclusive", async () => {
    const source = `<script setup lang="ts">
defineProps<{ status: "a" | "b" | "c" }>();
</script>
<template><p v-if="status === 'a'">A</p><p v-else-if="status === 'b'">B</p><p v-else>C</p></template>`;
    const result = await generateVariants({
      filename: "/p/Branch.vue",
      source,
    });
    expect(result.variants.map((variant) => variant.html).sort()).toEqual([
      "<p>A</p>",
      "<p>B</p>",
      "<p>C</p>",
    ]);
  });

  it("handles Suspense, Transition, Teleport, TransitionGroup, and a direct v-slot", async () => {
    const source = `<template>
  <Teleport to="#modal"><p>teleported</p></Teleport>
  <Transition name="fade"><p>transitioned</p></Transition>
  <TransitionGroup tag="ul"><li>row</li></TransitionGroup>
  <Suspense>
    <template v-slot:default><p>content</p></template>
    <template v-slot:fallback><p>loading</p></template>
  </Suspense>
</template>`;
    const result = await generateVariants({
      filename: "/p/Builtins.vue",
      source,
    });
    expect(result.variants.map((variant) => variant.html)).toEqual([
      "<p>teleported</p><p>transitioned</p><ul><li>row</li></ul><p>content</p>",
      "<p>teleported</p><p>transitioned</p><ul><li>row</li></ul><p>loading</p>",
    ]);
  });

  it("excludes components and slots silently, and diagnoses v-html and custom directives", async () => {
    const source = `<template>
  <MyComp foo="bar" />
  <slot name="header" />
  <div v-html="raw"></div>
  <span v-focus></span>
</template>`;
    const result = await generateVariants({ filename: "/p/Excl.vue", source });
    expect(result.variants[0]?.html).toBe("<div></div><span></span>");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "v-html-content-not-analyzed",
      "custom-directive-not-modeled",
    ]);
  });

  it("promotes an unevaluable predicate to independent local branches and correlates its negation", async () => {
    const source = `<script setup lang="ts">
defineProps<{ loggedIn: boolean }>();
</script>
<template>
  <p v-if="loggedIn">yes</p>
  <p v-if="!loggedIn">no</p>
  <p v-if="check()">unevaluable-a</p>
  <p v-if="check()">unevaluable-b</p>
</template>`;
    const result = await generateVariants({
      filename: "/p/Fallback.vue",
      source,
    });
    // loggedIn and !loggedIn share one decision (negation correlation); the
    // two textually identical but independent calls get their own local
    // decisions, so 1 + 2 = 3 total and both branches are generated for each.
    expect(result.stats.decisionCount).toBe(3);
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "expression-not-symbolically-evaluable",
      ),
    ).toHaveLength(2);
    for (const variant of result.variants) {
      expect(variant.html).toContain(
        variant.decisions[0]?.value ? "<p>yes</p>" : "<p>no</p>",
      );
    }
  });

  it("converts the .right and .middle click modifiers to their real event names", async () => {
    const source = `<template>
  <button @click.right="onRight">A</button>
  <button @click.middle="onMiddle">B</button>
  <button @keyup.right="onArrowRight">C</button>
</template>`;
    const result = await generateVariants({ filename: "/p/Click.vue", source });
    const variant = result.variants[0]!;
    expect(variant.html).toBe(
      '<button oncontextmenu="dummy-fn">A</button>' +
        '<button onmouseup="dummy-fn">B</button>' +
        '<button onkeyup="dummy-fn">C</button>',
    );
  });

  it("emits a v-pre subtree statically, without directive or interpolation processing", async () => {
    const source = `<script setup lang="ts">
defineProps<{ loggedIn: boolean }>();
</script>
<template><div v-pre v-if="loggedIn">{{ loggedIn }}</div></template>`;
    const result = await generateVariants({ filename: "/p/Pre.vue", source });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.html).toBe(
      '<div v-if="loggedIn">{{ loggedIn }}</div>',
    );
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
    ).toMatchObject({
      kind: "sentinel",
      reason: "non-finite-type",
      originalType: "string",
    });
    expect(
      variant.map.find(
        (entry) =>
          entry.kind === "attribute-name" &&
          variant.html.slice(entry.generated.start, entry.generated.end) ===
            "onclick",
      )?.provenance,
    ).toMatchObject({ kind: "synthetic", transformation: "vue-event" });
  });

  it("classifies a truly unresolvable dynamic attribute as unresolved-expression, not non-finite-type", async () => {
    const source = `<template><button :aria-pressed="undeclaredGlobal"></button></template>`;
    const result = await generateVariants({
      filename: "/p/Unresolved.vue",
      source,
    });
    const variant = result.variants[0]!;
    expect(
      variant.map.find((entry) => entry.kind === "attribute-value")?.provenance,
    ).toMatchObject({ kind: "sentinel", reason: "unresolved-expression" });
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
