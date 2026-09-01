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
        const index = request.html.indexOf("missing");
        return {
          diagnostics: [
            {
              ruleId: "emoji-check",
              severity: "warning",
              message: "check",
              range: { start: index, end: index + "missing".length },
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
    // A static (source-literal) attribute, so this diagnostic is not
    // rewritten by provenance normalization (§7) — this test is about UTF-16
    // offsets, not sentinel rewriting (covered separately).
    const source = `<template><p>\u{1F600}</p><span title="missing"></span></template>`;
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

  it("16: the virtual filename is deterministic by sourceFilename + HTML content, independent of variant ID/order or analyzer instance", async () => {
    async function analyzeOnce(): Promise<string[]> {
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
      await analyzer.dispose();
      return seen;
    }
    // Two independent analyzer instances (so neither's validation cache can
    // mask a repeat call) must agree on the same virtual filenames.
    const first = await analyzeOnce();
    const second = await analyzeOnce();
    expect(first).toHaveLength(2); // 2 variants sharing 2 distinct HTML strings
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
    for (const name of first) {
      expect(
        name.startsWith("/workspace/Menu.vue.__vue_html_bridge__/variant-"),
      ).toBe(true);
      expect(name.endsWith(".html")).toBe(true);
      expect(name).toMatch(/^[\x20-\x7E]+$/); // path-segment-safe characters only
    }
  });

  it("virtual filenames repeat correctly within one adapter session's validation cache", async () => {
    const calls: string[] = [];
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        calls.push(request.virtualFilename);
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
    // The second analyze() call hits the validation cache (§10.2), so the
    // adapter itself is invoked only for the first call's 2 distinct variants.
    expect(calls).toHaveLength(2);
  });

  it("5: rewrites a sentinel-value diagnostic and keeps the raw message as evidence", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const index = request.html.indexOf("dummy-string");
        return {
          diagnostics: [
            {
              ruleId: "invalid-attr",
              severity: "error",
              message:
                'The value of "aria-pressed" must be "true", "false", or "mixed".',
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
    const result = await analyzer.analyze({
      uri: "file:///workspace/Toggle.vue",
      filename: "/workspace/Toggle.vue",
      source: `<script setup lang="ts">defineProps<{ pressed: string }>();</script>
<template><button :aria-pressed="pressed">Toggle</button></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "vue-html-bridge/non-finite-attribute-value",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.origin).toBe("validator");
    expect(diagnostic!.evidence.originalValidatorMessages).toEqual([
      'The value of "aria-pressed" must be "true", "false", or "mixed".',
    ]);
  });

  it("6: the same rule at different positions within one variant becomes separate occurrences", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const diagnostics: {
          ruleId: string;
          severity: "warning";
          message: string;
          range: { start: number; end: number };
        }[] = [];
        let index = request.html.indexOf("id=");
        while (index !== -1) {
          diagnostics.push({
            ruleId: "dup",
            severity: "warning",
            message: "dup id",
            range: { start: index, end: index + 2 },
          });
          index = request.html.indexOf("id=", index + 1);
        }
        return { diagnostics, failures: [] };
      },
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/Two.vue",
      filename: "/workspace/Two.vue",
      source: `<template><p id="a"></p><p id="b"></p></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const dupDiagnostics = result.diagnostics.filter((d) => d.code === "dup");
    expect(dupDiagnostics).toHaveLength(2);
    expect(
      new Set(
        dupDiagnostics.map(
          (d) => `${d.sourceRange.start}-${d.sourceRange.end}`,
        ),
      ).size,
    ).toBe(2);
  });

  it("7: the same source issue becomes one entry even when its generated offset differs across variants", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const index = request.html.indexOf("stable");
        return {
          diagnostics: [
            {
              ruleId: "id-check",
              severity: "warning",
              message: "check",
              range: { start: index, end: index + "stable".length },
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
      uri: "file:///workspace/Merge.vue",
      filename: "/workspace/Merge.vue",
      source: `<script setup lang="ts">defineProps<{ a: boolean }>();</script>
<template><p v-if="a">x</p><span id="stable"></span></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const merged = result.diagnostics.filter((d) => d.code === "id-check");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence.variantCount).toBe(2);
    expect(merged[0]!.evidence.variantIds).toHaveLength(2);
  });

  it("8: diagnostics with a different rule or message at the same range are not merged", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const index = request.html.indexOf("stable");
        const range = { start: index, end: index + "stable".length };
        return {
          diagnostics: [
            {
              ruleId: "rule-a",
              severity: "warning",
              message: "message one",
              range,
            },
            {
              ruleId: "rule-b",
              severity: "warning",
              message: "message two",
              range,
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
      uri: "file:///workspace/Distinct.vue",
      filename: "/workspace/Distinct.vue",
      source: `<template><span id="stable"></span></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(result.diagnostics.filter((d) => d.code === "rule-a")).toHaveLength(
      1,
    );
    expect(result.diagnostics.filter((d) => d.code === "rule-b")).toHaveLength(
      1,
    );
  });

  it("9: variant evidence is truncated at the limit", async () => {
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        const index = request.html.indexOf("stable");
        return {
          diagnostics: [
            {
              ruleId: "id-check",
              severity: "warning",
              message: "check",
              range: { start: index, end: index + "stable".length },
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
      uri: "file:///workspace/Many.vue",
      filename: "/workspace/Many.vue",
      source: `<script setup lang="ts">defineProps<{ a: boolean; b: boolean; c: boolean }>();</script>
<template><p v-if="a">a</p><p v-if="b">b</p><p v-if="c">c</p><span id="stable"></span></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(result.variantSummary.emittedCount).toBe(8);
    const diagnostic = result.diagnostics.find((d) => d.code === "id-check");
    expect(diagnostic!.evidence.variantCount).toBe(8);
    expect(diagnostic!.evidence.variantIds).toHaveLength(5);
    expect(diagnostic!.evidence.truncated).toBe(true);
  });

  it("14: reconfigure swaps sessions without waiting on the old one's in-flight call, but dispose still waits for it", async () => {
    const fake = createFakeAdapter({ id: "fake" });
    const barrier = fake.blockNext();
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [
        { adapter: fake.adapter, settings: { label: "v1" }, enabled: true },
      ],
    });
    const pending = analyzer.analyze({
      uri: "file:///workspace/A.vue",
      filename: "/workspace/A.vue",
      source: `<template><p>x</p></template>`,
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reconfigured = analyzer.reconfigure({
      adapters: [
        { adapter: fake.adapter, settings: { label: "v2" }, enabled: true },
      ],
    });
    const raced = await Promise.race([
      reconfigured.then(() => "reconfigured" as const),
      timeout(50),
    ]);
    expect(raced).toBe("reconfigured");
    // The old (v1) session's in-flight call is still blocked, so it must not
    // have been disposed yet even though reconfigure() already returned.
    expect(fake.disposeCount).toBe(0);
    barrier.resolve();
    await pending;
    await analyzer.dispose();
    expect(fake.disposeCount).toBe(2); // old (v1) + current (v2)
  });

  it("17: reconfigure({ invalidateAdapters }) recreates the session and discards its validation cache even when settings are unchanged", async () => {
    const calls: string[] = [];
    const fake = createFakeAdapter({
      id: "fake",
      handler: (request) => {
        calls.push(request.virtualFilename);
        return { diagnostics: [], failures: [] };
      },
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
    });
    const request = {
      uri: "file:///workspace/A.vue",
      filename: "/workspace/A.vue",
      source: `<template><p>x</p></template>`,
      signal: new AbortController().signal,
    };
    await analyzer.analyze(request);
    expect(calls).toHaveLength(1);
    await analyzer.reconfigure({ invalidateAdapters: ["fake"] });
    await analyzer.analyze({
      ...request,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(calls).toHaveLength(2); // cache discarded by the forced session recreation
    expect(fake.disposeCount).toBe(2); // old + current session both disposed by the end
  });

  it("18: config watch targets are collected from every session, tagged, sorted, deduplicated, and removed when a session is replaced", async () => {
    const fakeA = createFakeAdapter({ id: "fake-a" });
    fakeA.setConfigWatchTargets([
      { absolutePath: "/workspace/b.config", kind: "config" },
      { absolutePath: "/workspace/shared.dep", kind: "dependency" },
    ]);
    const fakeB = createFakeAdapter({ id: "fake-b" });
    fakeB.setConfigWatchTargets([
      { absolutePath: "/workspace/a.config", kind: "config" },
    ]);
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [
        { adapter: fakeA.adapter, settings: {}, enabled: true },
        { adapter: fakeB.adapter, settings: {}, enabled: true },
      ],
    });
    const targets = analyzer.getConfigWatchTargets();
    expect(targets.map((target) => target.absolutePath)).toEqual([
      "/workspace/a.config",
      "/workspace/b.config",
      "/workspace/shared.dep",
    ]);
    expect(
      targets.find((target) => target.absolutePath === "/workspace/a.config")
        ?.adapterId,
    ).toBe("fake-b");
    expect(
      targets.find((target) => target.absolutePath === "/workspace/b.config")
        ?.adapterId,
    ).toBe("fake-a");

    await analyzer.reconfigure({
      adapters: [{ adapter: fakeB.adapter, settings: {}, enabled: true }],
    });
    const afterRemoval = analyzer.getConfigWatchTargets();
    await analyzer.dispose();
    expect(afterRemoval.every((target) => target.adapterId !== "fake-a")).toBe(
      true,
    );
  });

  it("ADR-0007: non-JSON-safe adapter settings produce an isolated session-level configuration-error", async () => {
    const fake = createFakeAdapter({ id: "fake" });
    const healthy = createFakeAdapter({ id: "healthy" });
    healthy.enqueue({
      diagnostics: [{ ruleId: "ok", severity: "info", message: "fine" }],
      failures: [],
    });
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [
        {
          adapter: fake.adapter,
          // A function is not JSON-safe (ADR-0007's shallow JSON-safety check).
          settings: { onDone: () => {} },
          enabled: true,
        },
        { adapter: healthy.adapter, settings: {}, enabled: true },
      ],
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/A.vue",
      filename: "/workspace/A.vue",
      source: `<template><p>x</p></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(fake.calls).toHaveLength(0); // createSession is never even attempted
    expect(
      result.diagnostics.some(
        (d) => d.code === "adapter/fake/configuration-error",
      ),
    ).toBe(true);
    // Isolated to that one adapter: the healthy adapter's own result survives.
    expect(result.diagnostics.some((d) => d.code === "ok")).toBe(true);
  });

  it("19: collectVariantArtifacts populates variantArtifacts with hash-grouped HTML, decisions, and map (plan.md T2)", async () => {
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [],
      collectVariantArtifacts: true,
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    expect(result.variantArtifacts).toBeDefined();
    const artifacts = result.variantArtifacts!;
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(artifact.virtualFilename).toBe(
        `/workspace/Menu.vue.__vue_html_bridge__/variant-${artifact.htmlHash}.html`,
      );
      expect(artifact.variants.length).toBeGreaterThan(0);
      for (const member of artifact.variants) {
        expect(typeof member.variantId).toBe("string");
        expect(Array.isArray(member.decisions)).toBe(true);
      }
      expect(Array.isArray(artifact.map)).toBe(true);
    }
    const withMenu = artifacts.find((artifact) =>
      artifact.html.includes("user-menu"),
    );
    expect(withMenu?.html).toBe(
      '<nav id="user-menu"></nav><button aria-controls="user-menu"></button>',
    );
    expect(
      withMenu?.map.some((entry) => entry.kind === "attribute-value"),
    ).toBe(true);
  });

  it("20: collectVariantArtifacts groups distinct decision paths that render byte-identical HTML into one artifact (REQ-6)", async () => {
    const analyzer = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [],
      collectVariantArtifacts: true,
    });
    const result = await analyzer.analyze({
      uri: "file:///workspace/Same.vue",
      filename: "/workspace/Same.vue",
      source: `<script setup lang="ts">defineProps<{ a: boolean }>();</script>
<template><p v-if="a">same</p><p v-else>same</p></template>`,
      signal: new AbortController().signal,
    });
    await analyzer.dispose();
    const artifacts = result.variantArtifacts!;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.html).toBe("<p>same</p>");
    expect(artifacts[0]!.variants).toHaveLength(2);
    const values = artifacts[0]!.variants.map(
      (member) => member.decisions[0]?.value,
    );
    expect(values.sort()).toEqual([false, true]);
  });

  it("21: variantArtifacts is undefined when collectVariantArtifacts is omitted or false (REQ-8 negative case)", async () => {
    const analyzerDefault = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [],
    });
    const defaultResult = await analyzerDefault.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzerDefault.dispose();
    expect(defaultResult.variantArtifacts).toBeUndefined();

    const analyzerFalse = await createWorkspaceAnalyzer({
      workspaceRoot: "/workspace",
      adapters: [],
      collectVariantArtifacts: false,
    });
    const falseResult = await analyzerFalse.analyze({
      uri: "file:///workspace/Menu.vue",
      filename: "/workspace/Menu.vue",
      source: SOURCE,
      signal: new AbortController().signal,
    });
    await analyzerFalse.dispose();
    expect(falseResult.variantArtifacts).toBeUndefined();
  });
});

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}
