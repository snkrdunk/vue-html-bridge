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

  // test-specs.md TC-2 through TC-16 (slot-fallback-validation SDD run).
  // TC-1 is the pre-existing test above,
  // "excludes components and slots silently, and diagnoses v-html and
  // custom directives" — it is re-run, not rewritten.

  it("TC-2: whitespace-only slot fallback content produces no output", async () => {
    const source = `<template><div><slot name="x">
</slot></div></template>`;
    const result = await generateVariants({
      filename: "/p/WsSlot.vue",
      source,
    });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.html).toBe("<div></div>");
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-3: comment-only slot fallback content produces no output", async () => {
    const source = `<template><div><slot name="x"><!-- placeholder --></slot></div></template>`;
    const result = await generateVariants({
      filename: "/p/CommentSlot.vue",
      source,
    });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.html).toBe("<div></div>");
    expect(result.diagnostics).toEqual([]);
  });

  it('TC-4: a slot fallback child gated by v-if="false" produces no output', async () => {
    const source = `<template><div><slot name="x"><img v-if="false" /></slot></div></template>`;
    const result = await generateVariants({
      filename: "/p/FalseIfSlot.vue",
      source,
    });
    // A literal v-if condition is, pre-existing and unrelated to this
    // feature (confirmed via a control case with no slot involved at all —
    // see test-results.md), still promoted to a [true, false] decision by
    // DecisionCollector rather than recognized as a compile-time constant,
    // so this produces 2 identical-html variants rather than 1. What FR-6
    // actually requires — that the gated fallback child contributes no
    // output — holds for every one of them, which is what this asserts.
    expect(result.variants.length).toBeGreaterThan(0);
    for (const variant of result.variants) {
      expect(variant.html).toBe("<div></div>");
    }
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-5: a named slot's fallback content replaces it with no leaked <slot> tag or name attribute", async () => {
    const source = `<template><div><slot name="header"><h1>Title</h1></slot></div></template>`;
    const result = await generateVariants({
      filename: "/p/NamedSlot.vue",
      source,
    });
    expect(result.variants[0]?.html).toBe("<div><h1>Title</h1></div>");
    expect(result.variants[0]?.html).not.toContain("<slot");
    expect(result.variants[0]?.html).not.toContain('name="header"');
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-6: v-if/v-else slot fallback branches, one with an undeclared custom directive", async () => {
    const source = `<script setup lang="ts">
defineProps<{ showsCartIcon: boolean }>();
</script>
<template>
  <div class="image">
    <slot name="image">
      <img v-if="!showsCartIcon" src="/thumb.jpg" alt="item" />
      <img v-else v-src="'/cart-icon.svg'" class="cart-icon" alt="cart" />
    </slot>
  </div>
</template>`;
    const result = await generateVariants({
      filename: "/p/SlotBranch.vue",
      source,
    });
    expect(result.variants).toHaveLength(2);
    const showsThumbnail = result.variants.find(
      (variant) => variant.decisions[0]?.value === false,
    );
    const showsIcon = result.variants.find(
      (variant) => variant.decisions[0]?.value === true,
    );
    expect(showsThumbnail?.html).toBe(
      '<div class="image"><img alt="item" src="/thumb.jpg"></div>',
    );
    expect(showsIcon?.html).toBe(
      '<div class="image"><img alt="cart" class="cart-icon"></div>',
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "custom-directive-not-modeled",
        message: "The DOM effects of v-src are not modeled.",
      }),
    );
    for (const variant of result.variants) {
      expect(variant.html).not.toContain("<slot");
      expect(variant.html).not.toContain('name="image"');
    }
  });

  it("TC-7: default and named slot, both with non-empty fallback, in one template", async () => {
    const source = `<template><slot name="x"><p>A</p></slot><slot><p>B</p></slot></template>`;
    const result = await generateVariants({
      filename: "/p/BothSlots.vue",
      source,
    });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.html).toBe("<p>A</p><p>B</p>");
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-8: default and named slot, both empty, in one template", async () => {
    const source = `<template><div><slot name="x" /><slot></slot></div></template>`;
    const result = await generateVariants({
      filename: "/p/BothEmptySlots.vue",
      source,
    });
    expect(result.variants[0]?.html).toBe("<div></div>");
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-9: a slot with fallback content used as a consumer-supplied child of an unrecognized component never leaks", async () => {
    const source = `<template><div>before</div><MyComp><slot name="x"><p>fallback-marker</p></slot></MyComp><div>after</div></template>`;
    const result = await generateVariants({
      filename: "/p/DroppedComp.vue",
      source,
    });
    expect(result.variants[0]?.html).toBe("<div>before</div><div>after</div>");
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-10: v-for directly on the slot element repeats its fallback content per iteration", async () => {
    const source = `<script setup lang="ts">
defineProps<{ items: string[] }>();
</script>
<template><ul><slot v-for="item in items" name="row">{{ item }}</slot></ul></template>`;
    const result = await generateVariants({
      filename: "/p/SlotForEach.vue",
      source,
    });
    expect(result.variants.map((variant) => variant.html)).toEqual([
      "<ul></ul>",
      "<ul>dummy-string</ul>",
      "<ul>dummy-stringdummy-string</ul>",
    ]);
    for (const variant of result.variants) {
      expect(variant.html).not.toContain("<slot");
    }
  });

  it("TC-11: v-if directly on the slot element itself is unaffected by this feature", async () => {
    const source = `<script setup lang="ts">
defineProps<{ cond: boolean }>();
</script>
<template><div><slot v-if="cond" name="x"><p>shown</p></slot></div></template>`;
    const result = await generateVariants({
      filename: "/p/SlotIf.vue",
      source,
    });
    expect(result.variants).toHaveLength(2);
    const shown = result.variants.find(
      (variant) => variant.decisions[0]?.value === true,
    );
    const hidden = result.variants.find(
      (variant) => variant.decisions[0]?.value === false,
    );
    expect(shown?.html).toBe("<div><p>shown</p></div>");
    expect(hidden?.html).toBe("<div></div>");
  });

  it("TC-12: a slot's fallback content nested inside Transition renders normally", async () => {
    const source = `<template><Transition name="fade"><slot name="x"><p>content</p></slot></Transition></template>`;
    const result = await generateVariants({
      filename: "/p/SlotInTransition.vue",
      source,
    });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.html).toBe("<p>content</p>");
    expect(result.diagnostics).toEqual([]);
  });

  it("TC-13: a named slot's fallback content nested inside Suspense's #default branch coexists with Suspense's own branch selection", async () => {
    const source = `<template>
  <Suspense>
    <template v-slot:default><slot name="x"><p>content</p></slot></template>
    <template v-slot:fallback><p>loading</p></template>
  </Suspense>
</template>`;
    const result = await generateVariants({
      filename: "/p/SlotInSuspense.vue",
      source,
    });
    expect(result.variants.map((variant) => variant.html).sort()).toEqual([
      "<p>content</p>",
      "<p>loading</p>",
    ]);
  });

  it("TC-15: v-bind and v-model on a slot fallback child work exactly as elsewhere", async () => {
    const source = `<script setup lang="ts">
defineProps<{ hint: string }>();
</script>
<template>
  <div>
    <slot name="search">
      <input v-model="query" :placeholder="hint" />
    </slot>
  </div>
</template>`;
    const result = await generateVariants({
      filename: "/p/SlotBindModel.vue",
      source,
    });
    expect(result.variants[0]?.html).toBe(
      '<div><input placeholder="dummy-string" value="dummy-string"></div>',
    );
    expect(result.variants[0]?.html).not.toContain("<slot");
    expect(result.variants[0]?.html).not.toContain('name="search"');
  });

  it("TC-16: v-html and v-text on slot fallback children behave exactly as they do outside a slot", async () => {
    const source = `<template>
  <div>
    <slot name="a"><div v-html="raw"></div></slot>
    <slot name="b"><span v-text="label"></span></slot>
  </div>
</template>`;
    const result = await generateVariants({
      filename: "/p/SlotHtmlText.vue",
      source,
    });
    expect(result.variants[0]?.html).toBe(
      "<div><div></div><span>dummy-string</span></div>",
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "v-html-content-not-analyzed",
    ]);
    expect(result.variants[0]?.html).not.toContain("<slot");
    expect(result.variants[0]?.html).not.toContain('name="a"');
    expect(result.variants[0]?.html).not.toContain('name="b"');
  });

  it("TC-14: OrderItem.vue fixture — named slot fallback becomes visible while the trailing empty default slot stays invisible, simultaneously", async () => {
    // Literal content of result/OrderItem.vue's <template> and <script setup>
    // (the <style> block is omitted — irrelevant to HTML generation, and no
    // other test in this file embeds one either). Copied verbatim, not a
    // re-derived approximation, per test-specs.md TC-14's own instruction —
    // this is the exact real-world fixture that motivated this feature.
    const source = `<template>
  <a
    class="list-item"
    :href="href"
    @click="() => onItemClick()"
  >
    <div class="image">
      <slot name="image">
        <img
          v-if="!showsCartIcon(transactionItem)"
          :src="transactionItem.thumbnailUrl"
          :alt="\`Item image for \${transactionItem.name}\`"
        />
        <img
          v-else
          v-src="'/img/account/cart-icon.svg'"
          alt="Shopping cart"
          class="cart-icon"
        />
      </slot>
    </div>
    <div class="info-wrapper">
      <div class="texts">
        <template v-if="isOrder(transactionItem) && isCartOrder(transactionItem)">
          <p class="title">Purchase ID {{ transactionItem.id }}</p>
        </template>

        <template v-else>
          <p class="title">{{ transactionItem.name }}</p>
          <p class="size">
            <template v-if="isListing(transactionItem)">Size: {{ transactionItem.size }}</template>
            <template v-else>
              <div
                v-if="transactionItem.itemCondition !== ''"
                class="condition"
              >
                {{ transactionItem.itemCondition }}
              </div>
              <template v-else>
                {{ capitalize(transactionItem.size) }}
              </template>
            </template>
          </p>
          <p
            v-if="isListing(transactionItem)"
            class="price"
          >
            Listing Price: {{ transactionItem.price }}
          </p>
        </template>

        <template v-if="isOrder(transactionItem)">
          <p class="transaction-status">
            <template v-if="isOrderCompleted(transactionItem)">
              Transaction Completed
              <span class="date">{{ formatFullDate(transactionItem.orderCompletedAt) }}</span>
            </template>
            <template v-else-if="isOrderCancelled(transactionItem)">
              Canceled
              <span class="date">{{ formatFullDate(transactionItem.orderCanceledAt) }}</span>
            </template>
            <template v-else-if="isOrderActive(transactionItem) || isCartOrder(transactionItem)">
              <template v-if="hasProcessingStatusLabel(transactionItem)">
                {{ transactionItem.processingStatusLabel }}
              </template>
              <template v-else-if="hasProcessingStatus(transactionItem)">
                {{ transactionItem.processingStatus }}
              </template>
            </template>
          </p>
          <p
            v-if="!isCartOrder(transactionItem)"
            class="transaction-id"
          >
            <template v-if="isCartSuborder(transactionItem)">(Order ID: {{ transactionItem.transactionId }})</template>
            <template v-else>(Order ID: {{ transactionItem.id }})</template>
          </p>
        </template>
        <slot></slot>
      </div>
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class="arrow"
      >
        <path
          d="M5.54 14C5.39 14 5.29 13.95 5.14 13.84C5.04554 13.7281 4.99371 13.5864 4.99371 13.44C4.99371 13.2936 5.04554 13.1519 5.14 13.04L9.74 8.03L5.14 2.96C5.04554 2.84813 4.99371 2.70643 4.99371 2.56C4.99371 2.41358 5.04554 2.27188 5.14 2.16C5.18687 2.10844 5.24399 2.06725 5.30771 2.03906C5.37142 2.01087 5.44033 1.99631 5.51 1.99631C5.57968 1.99631 5.64858 2.01087 5.7123 2.03906C5.77602 2.06725 5.83314 2.10844 5.88 2.16L10.85 7.66C11.05 7.86 11.05 8.24 10.85 8.46L5.93 13.84C5.78 13.94 5.68 14 5.53 14H5.54Z"
          fill="currentColor"
        />
      </svg>
    </div>
  </a>
</template>

<script setup lang="ts">
import { capitalize, computed } from 'vue';
import vSrc from '@/directives/vSrc';
import { ListingProduct } from '@/types/account';
import { ListOrder, OrderInCart } from '@/types/order';
import { LISTING_STATUS } from '@/utils/constants';
import { formatFullDate } from '@/utils/formatter';

type Order = ListOrder | OrderInCart;
type TransactionItem = Order | ListingProduct;
const props = defineProps<{
  transactionItem: TransactionItem;
}>();

const isOrder = (item: TransactionItem): item is Order => 'id' in item;
const isCartOrder = (item: TransactionItem) => 'isCartOrder' in item && item.isCartOrder;
const showsCartIcon = (item: TransactionItem) => isCartOrder(item) && !('isInstant' in item && item.isInstant);
const isListing = (item: TransactionItem): item is ListingProduct => 'uid' in item;

const isCartSuborder = (order: Order): order is OrderInCart => 'transactionId' in order && order.transactionId.length > 0;
const isOrderActive = (order: Order) => 'status' in order && order.status === 'active';
const isOrderCompleted = (order: Order): order is ListOrder & { orderCompletedAt: string } =>
  'orderCompletedAt' in order && order.orderCompletedAt !== null;
const isOrderCancelled = (order: Order): order is ListOrder & { orderCanceledAt: string } =>
  'orderCanceledAt' in order && order.orderCanceledAt !== null;
const hasProcessingStatusLabel = (order: Order): order is ListOrder => 'processingStatusLabel' in order;
const hasProcessingStatus = (order: Order): order is OrderInCart => 'processingStatus' in order;

const href = computed(() => {
  // Listing doesn't use href since we have to prevent navigation if the item
  // is in process
  if (isListing(props.transactionItem)) {
    return '#';
  }

  // Orders doesn't have a special navigation requirement
  if (isCartSuborder(props.transactionItem)) {
    return \`/en/account/orders/cart/order/\${props.transactionItem.id}?slide=right\`;
  }
  if (isCartOrder(props.transactionItem)) {
    return \`/en/account/orders/cart/\${props.transactionItem.id}/items?slide=right\`;
  }
  return \`/en/account/orders/\${props.transactionItem.id}?slide=right\`;
});

const onItemClick = () => {
  const { transactionItem } = props;
  if (isOrder(transactionItem)) {
    return;
  }

  if (transactionItem.status === LISTING_STATUS.PROCESSING) {
    alert('This item is in the process of being purchased and cannot be edited.');
    return;
  }
  globalThis.location.href = \`/en/account/listings/\${transactionItem.uid}?slide=view\`;
};
</script>
`;
    const result = await generateVariants({
      filename: "/p/OrderItem.vue",
      source,
    });

    // FR-9a: every variant's .image is exactly one of the two known
    // shapes — never empty, never anything else. This directly falsifies
    // today's bug (every variant currently shows an empty .image div) for
    // every generated variant, not just some of them, without depending on
    // knowing the total variant count or how decisions are enumerated.
    const imageShape =
      /<div class="image">(?:<img alt="dummy-string" src="dummy-string">|<img alt="Shopping cart" class="cart-icon">)<\/div>/;
    for (const variant of result.variants) {
      expect(variant.html).toMatch(imageShape);
    }

    // Both branches are actually reachable in this run, not just
    // structurally possible.
    expect(
      result.variants.some((variant) =>
        variant.html.includes(
          '<div class="image"><img alt="dummy-string" src="dummy-string"></div>',
        ),
      ),
    ).toBe(true);
    expect(
      result.variants.some((variant) =>
        variant.html.includes(
          '<div class="image"><img alt="Shopping cart" class="cart-icon"></div>',
        ),
      ),
    ).toBe(true);

    // FR-3: the undeclared v-src directive still produces its existing,
    // unchanged diagnostic — proving the fallback content goes through
    // real directive-diagnostic machinery, not a placeholder path.
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "custom-directive-not-modeled" }),
    );

    // FR-2 + FR-9b: neither slot's own tag ever leaks, for any variant —
    // covers both the non-empty named slot and the genuinely-empty
    // trailing default slot holding simultaneously across the whole file.
    for (const variant of result.variants) {
      expect(variant.html).not.toContain("<slot");
    }
  });
});

// plan.md "Custom-directive attribute value modeling ('Plan B')" / ADR-0010.
describe("generateVariants: custom-directive attribute value modeling", () => {
  it("resolves a single attribute from a literal bound expression", async () => {
    const source = `<template><img v-src="'/icon.svg'" alt="icon" /></template>`;
    const result = await generateVariants({
      filename: "/p/Single.vue",
      source,
      options: {
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      },
    });
    expect(result.variants[0]?.html).toBe('<img alt="icon" src="/icon.svg">');
    expect(result.diagnostics).toEqual([]);
  });

  it("fans out multiple attributes from one bound object expression, keeping a constant attribute source-literal while its value-path siblings share the bound expression's provenance", async () => {
    const source = `<script setup lang="ts">
defineProps<{ status: "a" | "b" }>();
</script>
<template><img v-img-attr="{ src: status, height: 24 }" /></template>`;
    const result = await generateVariants({
      filename: "/p/ImgAttr.vue",
      source,
      options: {
        customDirectives: [
          {
            name: "imgAttr",
            attributes: {
              src: "$value.src",
              height: "$value.height",
              role: "img",
            },
          },
        ],
      },
    });
    expect(result.variants).toHaveLength(2);
    const variantA = result.variants.find(
      (variant) => variant.decisions[0]?.value === "a",
    );
    expect(variantA?.html).toBe('<img height="24" role="img" src="a">');
    const attributeValues = variantA!.map.filter(
      (entry) => entry.kind === "attribute-value",
    );
    expect(attributeValues.map((entry) => entry.provenance.kind)).toEqual([
      "finite-domain", // height
      "source-literal", // role (constant)
      "finite-domain", // src
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("falls back to a placeholder plus an info diagnostic when the bound expression can't be evaluated (a function call, not the real repro's literal)", async () => {
    const source = `<script setup lang="ts">
defineProps<{ name: string }>();
</script>
<template><img v-src="computeUrl(name)" /></template>`;
    const result = await generateVariants({
      filename: "/p/Unresolved.vue",
      source,
      options: {
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      },
    });
    expect(result.variants[0]?.html).toBe('<img src="dummy-string">');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "custom-directive-value-unresolved",
        severity: "info",
      }),
    ]);
  });

  it.each([
    ["null", "null"],
    ["undefined", "undefined"],
    ["false", "false"],
  ])(
    "drops the attribute when the resolved value is %s, reusing attributeFromValue's existing rule with no new diagnostic",
    async (_label, expression) => {
      const source = `<template><input v-toggle="${expression}" /></template>`;
      const result = await generateVariants({
        filename: "/p/Toggle.vue",
        source,
        options: {
          customDirectives: [
            { name: "toggle", attributes: { disabled: "$value" } },
          ],
        },
      });
      expect(result.variants[0]?.html).toBe("<input>");
      expect(result.diagnostics).toEqual([]);
    },
  );

  it("registers a decision for a value-path directive's bound expression (DecisionCollector regression guard)", async () => {
    const source = `<script setup lang="ts">
defineProps<{ status: "on" | "off" }>();
</script>
<template><img v-src="status === 'on' ? '/on.svg' : '/off.svg'" /></template>`;
    const result = await generateVariants({
      filename: "/p/Branch.vue",
      source,
      options: {
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      },
    });
    expect(result.variants).toHaveLength(2);
    const on = result.variants.find(
      (variant) => variant.decisions[0]?.value === "on",
    );
    const off = result.variants.find(
      (variant) => variant.decisions[0]?.value === "off",
    );
    expect(on?.html).toBe('<img src="/on.svg">');
    expect(off?.html).toBe('<img src="/off.svg">');
    const provenance = on!.map.find(
      (entry) => entry.kind === "attribute-value",
    )?.provenance;
    expect(provenance).toMatchObject({ kind: "finite-domain" });
  });

  it("leaves an undeclared directive's dispatch unchanged when unrelated customDirectives are configured", async () => {
    const source = `<template><span v-focus></span></template>`;
    const result = await generateVariants({
      filename: "/p/Undeclared.vue",
      source,
      options: {
        customDirectives: [{ name: "src", attributes: { src: "$value" } }],
      },
    });
    expect(result.variants[0]?.html).toBe("<span></span>");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "custom-directive-not-modeled",
    ]);
  });

  it("emits a bare-word literal constant verbatim instead of evaluating it as an expression, even with no bound expression at all", async () => {
    const source = `<template><div v-status-badge></div></template>`;
    const result = await generateVariants({
      filename: "/p/Constant.vue",
      source,
      options: {
        customDirectives: [
          { name: "statusBadge", attributes: { role: "status" } },
        ],
      },
    });
    expect(result.variants[0]?.html).toBe('<div role="status"></div>');
    expect(result.diagnostics).toEqual([]);
    const provenance = result.variants[0]?.map.find(
      (entry) => entry.kind === "attribute-value",
    )?.provenance;
    expect(provenance).toMatchObject({ kind: "source-literal" });
  });

  it("matches a template directive by camelized name regardless of which spelling was declared", async () => {
    const resultKebabTemplate = await generateVariants({
      filename: "/p/CamelA.vue",
      source: `<template><img v-img-attr="'/a.svg'" /></template>`,
      options: {
        customDirectives: [{ name: "imgAttr", attributes: { src: "$value" } }],
      },
    });
    expect(resultKebabTemplate.variants[0]?.html).toBe('<img src="/a.svg">');

    const resultCamelTemplate = await generateVariants({
      filename: "/p/CamelB.vue",
      source: `<template><img v-imgAttr="'/b.svg'" /></template>`,
      options: {
        customDirectives: [{ name: "img-attr", attributes: { src: "$value" } }],
      },
    });
    expect(resultCamelTemplate.variants[0]?.html).toBe('<img src="/b.svg">');
  });

  it("does not register a decision for an all-constant mapping even if its bound expression references a finite-domain binding", async () => {
    const source = `<script setup lang="ts">
defineProps<{ status: "on" | "off" }>();
</script>
<template><div v-badge="status"></div></template>`;
    const result = await generateVariants({
      filename: "/p/AllConstant.vue",
      source,
      options: {
        customDirectives: [{ name: "badge", attributes: { role: "status" } }],
      },
    });
    expect(result.stats.decisionCount).toBe(0);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.html).toBe('<div role="status"></div>');
  });

  describe("core-side defensive validation (bypassing settings, v3)", () => {
    it("drops a reserved-directive-name mapping with one warning; dispatch of the real directive is unaffected", async () => {
      const source = `<template><div :id="'x'"></div></template>`;
      const result = await generateVariants({
        filename: "/p/Reserved.vue",
        source,
        options: {
          customDirectives: [{ name: "bind", attributes: { foo: "bar" } }],
        },
      });
      expect(result.variants[0]?.html).toBe('<div id="x"></div>');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "custom-directive-mapping-invalid",
          severity: "warning",
        }),
      ]);
    });

    it("drops one invalid attribute key with a warning; it is never serialized", async () => {
      const source = `<template><div v-badge="'x'"></div></template>`;
      const result = await generateVariants({
        filename: "/p/BadKey.vue",
        source,
        options: {
          customDirectives: [
            {
              name: "badge",
              attributes: { "bad key": "constant-value", role: "status" },
            },
          ],
        },
      });
      expect(result.variants[0]?.html).toBe('<div role="status"></div>');
      expect(result.variants[0]?.html).not.toContain("bad key");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "custom-directive-mapping-invalid",
          severity: "warning",
        }),
      ]);
    });

    it("drops a malformed $value-containing template at parse time with a warning; sibling attributes survive", async () => {
      const source = `<template><img v-src="'/a.svg'" /></template>`;
      const result = await generateVariants({
        filename: "/p/BadTemplate.vue",
        source,
        options: {
          customDirectives: [
            { name: "src", attributes: { src: "$value[0]", alt: "icon" } },
          ],
        },
      });
      expect(result.variants[0]?.html).toBe('<img alt="icon">');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "custom-directive-mapping-invalid",
          severity: "warning",
          message: expect.stringContaining(
            'value template for attribute "src"',
          ),
        }),
      ]);
    });

    it("drops the whole entry when a malformed template was its only attribute; the usage falls back to custom-directive-not-modeled", async () => {
      const source = `<template><img v-src="'/a.svg'" /></template>`;
      const result = await generateVariants({
        filename: "/p/BadTemplateOnly.vue",
        source,
        options: {
          customDirectives: [{ name: "src", attributes: { src: "$value[0]" } }],
        },
      });
      expect(result.variants[0]?.html).toBe("<img>");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "custom-directive-mapping-invalid",
        "custom-directive-not-modeled",
      ]);
    });

    it("drops all camelized-duplicate entries (no winner); the template usage falls back to custom-directive-not-modeled", async () => {
      const source = `<template><img v-img-attr="'/a.svg'" /></template>`;
      const result = await generateVariants({
        filename: "/p/Dup.vue",
        source,
        options: {
          customDirectives: [
            { name: "img-attr", attributes: { src: "$value" } },
            { name: "imgAttr", attributes: { src: "$value" } },
          ],
        },
      });
      expect(result.variants[0]?.html).toBe("<img>");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "custom-directive-mapping-invalid",
        "custom-directive-not-modeled",
      ]);
    });
  });

  describe("own-property-only $value lookup (v3 hardening)", () => {
    it.each(["constructor", "toString", "__proto__"])(
      "treats $value.%s as a missing own property, never an inherited one",
      async (key) => {
        const source = `<template><div v-badge="{ role: 'status' }"></div></template>`;
        const result = await generateVariants({
          filename: "/p/OwnProp.vue",
          source,
          options: {
            customDirectives: [
              {
                name: "badge",
                attributes: { [`data-${key}`]: `$value.${key}` },
              },
            ],
          },
        });
        expect(result.variants[0]?.html).toBe("<div></div>");
        expect(result.diagnostics).toEqual([]);
      },
    );
  });

  it("resolves to a sentinel with an info diagnostic for a $value template when the directive has no bound expression at all", async () => {
    const source = `<template><div v-badge></div></template>`;
    const result = await generateVariants({
      filename: "/p/NoExp.vue",
      source,
      options: {
        customDirectives: [{ name: "badge", attributes: { role: "$value" } }],
      },
    });
    expect(result.variants[0]?.html).toBe('<div role="dummy-string"></div>');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "custom-directive-value-unresolved",
        severity: "info",
      }),
    ]);
  });
});
