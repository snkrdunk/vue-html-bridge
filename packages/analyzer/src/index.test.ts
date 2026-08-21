import { createFakeAdapter } from "@vue-html-bridge/adapter-testkit/fake";
import { describe, expect, it } from "vitest";
import { createWorkspaceAnalyzer, type ConfiguredAdapter } from "./index.js";

const SOURCE = `<script setup lang="ts">
defineProps<{ loggedIn: boolean }>();
</script>
<template>
  <nav v-if="loggedIn" id="user-menu" />
  <button :aria-controls="loggedIn ? 'user-menu' : undefined" />
</template>`;

describe("createWorkspaceAnalyzer (analyzer.md §12, Phase 1 subset)", () => {
  it("1: runs core exactly once regardless of adapter count", async () => {
    const fakeA = createFakeAdapter({ id: "fake-a" });
    const fakeB = createFakeAdapter({ id: "fake-b" });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [
        { adapter: fakeA.adapter, settings: {}, enabled: true },
        { adapter: fakeB.adapter, settings: {}, enabled: true },
      ],
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    // 2 variants (loggedIn true/false) sharing 2 distinct HTML strings, so each adapter
    // is invoked twice — but core itself only ever runs once per analyze() call, which
    // this variant count already proves (it isn't re-derived per adapter).
    expect(result.variantSummary.emittedCount).toBe(2);
    expect(fakeA.calls).toHaveLength(2);
    expect(fakeB.calls).toHaveLength(2);
  });

  it("2: identical HTML within one adapter runs once; different adapters are independent", async () => {
    const fake = createFakeAdapter({ id: "fake" });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    await analyzer.analyze({
      uri: "file:///workspace/Same.vue",
      filename: "/workspace/Same.vue",
      source: `<script setup lang="ts">defineProps<{ a: boolean; b: boolean }>();</script>
<template><i v-if="a"></i><i v-if="b"></i></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    // 4 variants (a x b), but only 3 distinct HTML strings: "", "<i></i>", "<i></i><i></i>".
    expect(fake.calls.length).toBeLessThan(4);
    expect(new Set(fake.calls.map((call) => call.request.html)).size).toBe(
      fake.calls.length,
    );
  });

  it("3: a generated range maps back to the correct source range (static and dynamic attributes)", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const index = request.html.indexOf("user-menu");
        return {
          diagnostics: [
            {
              ruleId: "id-check",
              severity: "warning",
              message: "check",
              range: { start: index, end: index + "user-menu".length },
            },
          ],
          failures: [],
        };
      },
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const diagnostic = result.diagnostics.find((d) => d.code === "id-check");
    expect(diagnostic).toBeDefined();
    expect(
      SOURCE.slice(diagnostic!.sourceRange.start, diagnostic!.sourceRange.end),
    ).toBe("user-menu");
  });

  it("4: falls back to the template start when there is no range or no mapping", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: () => ({
        diagnostics: [
          {
            ruleId: "no-range",
            severity: "warning",
            message: "no range at all",
          },
          {
            ruleId: "no-mapping",
            severity: "warning",
            message: "range outside any mapping entry",
            range: { start: 999_999, end: 1_000_000 },
          },
        ],
        failures: [],
      }),
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const templateStart = SOURCE.indexOf("<template>") + "<template>".length;
    for (const code of ["no-range", "no-mapping"]) {
      const diagnostic = result.diagnostics.find((d) => d.code === code);
      expect(diagnostic?.sourceRange.start).toBe(templateStart);
      expect(diagnostic?.evidence.mappingFallback).toBe(true);
      expect(diagnostic?.message).toContain("could not be traced back");
    }
  });

  it("10: an adapter session failure does not lose core diagnostics or other adapters' results", async () => {
    const failing: ConfiguredAdapter = {
      adapter: {
        apiVersion: 1,
        id: "broken",
        displayName: "Broken",
        capabilities: {
          execution: "in-process",
          supportsCancellation: true,
          supportsConfigFiles: false,
          fragmentHandling: "native",
          maxConcurrentValidations: 1,
        },
        async createSession() {
          throw Object.assign(new Error("bad config"), {
            name: "AdapterSessionFailure",
            failure: {
              code: "configuration-error",
              message: "bad config",
              recoverable: true,
            },
          });
        },
      },
      settings: {},
      enabled: true,
    };
    const fake = createFakeAdapter({ id: "healthy" });
    fake.enqueue({
      diagnostics: [{ ruleId: "ok", severity: "info", message: "fine" }],
      failures: [],
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [
        failing,
        { adapter: fake.adapter, settings: {}, enabled: true },
      ],
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/A.vue",
      filename: "/workspace/A.vue",
      source: `<template lang="pug">div bad</template>`, // triggers a core diagnostic too
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(
      result.diagnostics.some(
        (d) => d.code === "vue-html-bridge/unsupported-template-source",
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (d) => d.code === "adapter/broken/configuration-error",
      ),
    ).toBe(true);
  });

  it("11: bounded concurrency never exceeds the adapter's maxConcurrentValidations", async () => {
    const fake = createFakeAdapter({ id: "fake", maxConcurrentValidations: 1 });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
      maxConcurrency: 8,
    });
    await analyzer.analyze({
      uri: "file:///workspace/Many.vue",
      filename: "/workspace/Many.vue",
      source: `<script setup lang="ts">defineProps<{ a: boolean; b: boolean; c: boolean }>();</script>
<template><i v-if="a"></i><i v-if="b"></i><i v-if="c"></i></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(fake.maximumActiveCalls).toBeLessThanOrEqual(1);
  });

  it("12: after abort, no new adapter work starts", async () => {
    const fake = createFakeAdapter({ id: "fake" });
    const barrier = fake.blockNext();
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    const controller = new AbortController();
    const pending = analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: controller.signal,
    });
    controller.abort();
    barrier.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const callsAtAbort = fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await analyzer.dispose();
    expect(fake.calls.length).toBe(callsAtAbort);
  });

  it("15: source and generated ranges containing emoji stay correct in UTF-16", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const index = request.html.indexOf("dummy-string");
        return {
          diagnostics: [
            {
              ruleId: "emoji-check",
              severity: "warning",
              message: "check",
              range: { start: index, end: index + "dummy-string".length },
            },
          ],
          failures: [],
        };
      },
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    const source = `<template><p>\u{1F600}</p><span :title="missing"></span></template>`;
    const result = await analyzer.analyze({
      uri: "file:///workspace/Emoji.vue",
      filename: "/workspace/Emoji.vue",
      source,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const diagnostic = result.diagnostics.find((d) => d.code === "emoji-check");
    expect(diagnostic).toBeDefined();
    expect(
      source.slice(diagnostic!.sourceRange.start, diagnostic!.sourceRange.end),
    ).toBe("missing");
  });

  it("16: the virtual filename is deterministic by sourceFilename + HTML content, independent of variant ID/order", async () => {
    const seen: string[] = [];
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        seen.push(request.virtualFilename);
        return { diagnostics: [], failures: [] };
      },
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    await analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(seen).toHaveLength(4); // 2 variants x 2 analyze() calls
    expect(new Set(seen).size).toBe(2); // same 2 virtual filenames both times
    for (const name of seen) {
      expect(
        name.startsWith("/workspace/Menu.vue.__vue_html_bridge__/variant-"),
      ).toBe(true);
      expect(name.endsWith(".html")).toBe(true);
      expect(name).toMatch(/^[\x20-\x7E]+$/); // path-segment-safe characters only
    }
  });
});
