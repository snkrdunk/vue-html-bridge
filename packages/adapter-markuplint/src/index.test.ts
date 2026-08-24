import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultSearchPlaces } from "cosmiconfig";
import { MLEngine } from "markuplint";
import type { MLResultInfo } from "markuplint";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdapterContractCases,
  type AdapterContractFixture,
} from "@vue-html-bridge/adapter-testkit";
import { defineVitestAdapterContract } from "@vue-html-bridge/adapter-testkit/vitest";
import {
  nullLogger,
  type ValidateHtmlRequest,
} from "@vue-html-bridge/validator-api";
import { markuplintAdapter } from "./index.js";
import type { MarkuplintAdapterSettings } from "./settings.js";
import { toGeneratedDiagnostics } from "./violation-converter.js";

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vhb-adapter-markuplint-"));
  tempDirs.push(dir);
  return dir;
}

function request(
  workspaceRoot: string,
  html: string,
  sourceFilename = join(workspaceRoot, "Fixture.vue"),
): ValidateHtmlRequest {
  return {
    html,
    documentKind: "fragment",
    sourceFilename,
    virtualFilename: `${sourceFilename}.__vue_html_bridge__/variant-t.html`,
  };
}

// §9.1: the contract suite from adapter-testkit, run against the real adapter.
const contractFixture: AdapterContractFixture<MarkuplintAdapterSettings> = {
  adapter: markuplintAdapter,
  workspaceRoot: tmpdir(),
  settings: {},
  validHtml: "<p>Hello</p>",
  invalidHtml: {
    html: '<img src="a.png">',
    expectedRuleId: "required-attr",
    expectedSubstring: "img",
  },
  createFailureSettings: () => ({ configFile: "does-not-exist.json" }),
};
defineVitestAdapterContract("markuplint adapter contract", contractFixture);

describe("adapter-markuplint: Markuplint-specific fixtures (adapter-markuplint.md §9.2)", () => {
  it("1: an explicit settings.configFile takes priority over auto-discovery", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, "auto.json"),
      JSON.stringify({ rules: { "id-duplication": false } }),
    );
    await writeFile(
      join(root, "explicit.json"),
      JSON.stringify({ rules: { "id-duplication": true } }),
    );
    // An auto-discoverable config sits at the workspace root; it should be
    // ignored because settings.configFile is explicit.
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: { configFile: "explicit.json" },
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, '<div id="x"></div><div id="x"></div>'),
      new AbortController().signal,
    );
    await session.dispose();
    expect(result.diagnostics.some((d) => d.ruleId === "id-duplication")).toBe(
      true,
    );
  });

  it("2: extends, plugins, top-level rules, and nodeRules all resolve from one explicit config", async () => {
    const root = await tempWorkspace();
    const pluginPath = join(root, "vhb-test-plugin.mjs");
    // A minimal real Markuplint plugin (not installed from npm): resolved by
    // MLEngine as an absolute module specifier (§3's fromCode contract), and
    // its rule is prefixed `<plugin name>/<rule name>` by Markuplint's own
    // resolveRules() — this is genuine plugin resolution, not a stand-in.
    await writeFile(
      pluginPath,
      `export default {
  name: "vhb-test-plugin",
  create() {
    return {
      rules: {
        "always-fire": {
          defaultSeverity: "warning",
          verify({ report }) {
            report({ line: 1, col: 1, raw: "", message: "vhb-test-plugin fired" });
          },
        },
      },
    };
  },
};
`,
    );
    await writeFile(
      join(root, "combined.json"),
      JSON.stringify({
        extends: ["markuplint:recommended-static-html"],
        plugins: [pluginPath],
        rules: {
          "id-duplication": true,
          "vhb-test-plugin/always-fire": true,
        },
        nodeRules: [{ selector: "img", rules: { "required-attr": ["alt"] } }],
      }),
    );

    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: { configFile: "combined.json", profile: "as-configured" },
      logger: nullLogger,
    });
    try {
      const result = await session.validate(
        request(root, '<img id="x" src="a.png"><img id="x" src="b.png">'),
        new AbortController().signal,
      );
      const ruleIds = result.diagnostics.map((d) => d.ruleId);
      expect(ruleIds).toContain("id-duplication"); // top-level `rules`
      expect(ruleIds).toContain("required-attr"); // `nodeRules`: img requires alt
      expect(ruleIds).toContain("vhb-test-plugin/always-fire"); // `plugins`

      // `extends: markuplint:recommended-static-html` pulls in `end-tag` on
      // top of this config's own (unrelated) rules block.
      const extendsResult = await session.validate(
        request(root, "<div>"),
        new AbortController().signal,
      );
      expect(
        extendsResult.diagnostics.some((d) => d.ruleId === "end-tag"),
      ).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it("9: the generated-html profile disables source-format rules while keeping semantic ones, and priority runs Markuplint defaults < user config < overlay < profileRuleOverrides", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({ rules: { "id-duplication": true } }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    try {
      // case-sensitive-tag-name is disabled by the generated-html profile.
      const overlayResult = await session.validate(
        request(root, "<DIV>hi</DIV>"),
        new AbortController().signal,
      );
      expect(
        overlayResult.diagnostics.some(
          (d) => d.ruleId === "case-sensitive-tag-name",
        ),
      ).toBe(false);

      // The user's own discovered config still applies underneath the overlay.
      const userConfigResult = await session.validate(
        request(root, '<div id="x"></div><div id="x"></div>'),
        new AbortController().signal,
      );
      expect(
        userConfigResult.diagnostics.some((d) => d.ruleId === "id-duplication"),
      ).toBe(true);

      // markuplint:recommended-static-html (the overlay's own baseline) still
      // fires, and its range correctly covers the unclosed opening tag (§9.2
      // item 7's "end tag" position case).
      const baselineHtml = "<div>";
      const baselineResult = await session.validate(
        request(root, baselineHtml),
        new AbortController().signal,
      );
      const endTagViolation = baselineResult.diagnostics.find(
        (d) => d.ruleId === "end-tag",
      );
      expect(endTagViolation).toBeDefined();
      expect(endTagViolation?.range).toBeDefined();
      expect(
        baselineHtml.slice(
          endTagViolation!.range!.start,
          endTagViolation!.range!.end,
        ).length,
      ).toBeGreaterThan(0);
    } finally {
      await session.dispose();
    }
  });

  it("profileRuleOverrides re-enables a rule the overlay disabled", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: { profileRuleOverrides: { "case-sensitive-tag-name": true } },
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, "<DIV>hi</DIV>"),
      new AbortController().signal,
    );
    await session.dispose();
    expect(
      result.diagnostics.some((d) => d.ruleId === "case-sensitive-tag-name"),
    ).toBe(true);
  });

  it('profile: "as-configured" applies the discovered config strictly, without the generated-html overlay', async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({
        extends: ["markuplint:recommended-static-html"],
        rules: { "case-sensitive-tag-name": true },
      }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: { profile: "as-configured" },
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, "<DIV>hi</DIV>"),
      new AbortController().signal,
    );
    await session.dispose();
    // Not disabled here — the generated-html overlay never ran.
    expect(
      result.diagnostics.some((d) => d.ruleId === "case-sensitive-tag-name"),
    ).toBe(true);
  });

  it("3: the virtual .html is parsed as HTML even when a .vue parser mapping exists in config", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({ parser: { "\\.vue$": "@markuplint/vue-parser" } }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    // Would throw resolving the (uninstalled) vue-parser if the mapping applied.
    await expect(
      session.validate(
        request(root, "<p>ok</p>"),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ failures: [] });
    await session.dispose();
  });

  it("4: an override targeting the bridge's synthetic virtual-path pattern applies to the generated HTML", async () => {
    const root = await tempWorkspace();
    // The exact glob from adapter-markuplint.md §4.2's own worked example.
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({
        rules: { "case-sensitive-tag-name": false },
        overrides: {
          "**/*.vue.__vue_html_bridge__/**/*.html": {
            rules: { "case-sensitive-tag-name": true },
          },
        },
      }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: { profile: "as-configured" },
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, "<DIV>hi</DIV>"),
      new AbortController().signal,
    );
    await session.dispose();
    // The base config disables the rule; the override re-enables it only for
    // paths under the bridge's synthetic __vue_html_bridge__ suffix, which
    // `virtualFilename` (validator-api §3.2) always matches, and which a
    // `.vue`-targeted override never does (§4.2, exercised by item 3 above).
    expect(
      result.diagnostics.some((d) => d.ruleId === "case-sensitive-tag-name"),
    ).toBe(true);
  });

  it("5/6: rule/severity/range are correct, deterministic across repeated runs, and stable when the same markup has multiple violations", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    // Two independent violations in one document: id-duplication (content
    // model) and required-attr (missing alt), plus an emoji and a real
    // multi-line break, so determinism is checked with more than one
    // violation present (§9.2 item 6), not just one.
    const html =
      '<p id="x">\u{1F600}</p>\n<div id="x"></div>\n<img src="a.png">';
    const first = await session.validate(
      request(root, html),
      new AbortController().signal,
    );
    const second = await session.validate(
      request(root, html),
      new AbortController().signal,
    );
    await session.dispose();
    expect(first.diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(first.diagnostics.some((d) => d.ruleId === "id-duplication")).toBe(
      true,
    );
    expect(first.diagnostics.some((d) => d.ruleId === "required-attr")).toBe(
      true,
    );
    expect(first.diagnostics).toEqual(second.diagnostics);
    const violation = first.diagnostics.find(
      (d) => d.ruleId === "required-attr",
    );
    expect(violation?.range).toBeDefined();
    expect(
      html.slice(violation!.range!.start, violation!.range!.end),
    ).toContain("img");
  });

  it("5: an ARIA violation (wai-aria) is reported with a range over the invalid value", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const html = '<button aria-pressed="dummy-string">Toggle</button>';
    const result = await session.validate(
      request(root, html),
      new AbortController().signal,
    );
    await session.dispose();
    const violation = result.diagnostics.find((d) => d.ruleId === "wai-aria");
    expect(violation).toBeDefined();
    expect(violation?.applicability).toBe("html-semantics");
    expect(violation?.range).toBeDefined();
    expect(
      html.slice(violation!.range!.start, violation!.range!.end),
    ).toContain("dummy-string");
  });

  it("7: violation positions are correct across a CRLF line break and a combining-mark sequence", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    try {
      const crlfHtml = '<p>ok</p>\r\n<img src="a.png">';
      const crlfResult = await session.validate(
        request(root, crlfHtml),
        new AbortController().signal,
      );
      const crlfViolation = crlfResult.diagnostics.find(
        (d) => d.ruleId === "required-attr",
      );
      expect(crlfViolation?.range).toBeDefined();
      expect(
        crlfHtml.slice(crlfViolation!.range!.start, crlfViolation!.range!.end),
      ).toContain("img");

      // "e" + COMBINING ACUTE ACCENT: 2 separate UTF-16 code units, not 1
      // grapheme (adapter-markuplint.md §6.1, pinned by the Phase 0 spike).
      const combiningHtml = 'é<img src="a.png">';
      const combiningResult = await session.validate(
        request(root, combiningHtml),
        new AbortController().signal,
      );
      const combiningViolation = combiningResult.diagnostics.find(
        (d) => d.ruleId === "required-attr",
      );
      expect(combiningViolation?.range).toBeDefined();
      expect(
        combiningHtml.slice(
          combiningViolation!.range!.start,
          combiningViolation!.range!.end,
        ),
      ).toContain("img");
      // "e" (1 unit) + combining mark (1 unit) => "<img" starts at offset 2.
      // If the combining mark were miscounted as 1 grapheme, this would be 1.
      expect(combiningViolation?.range?.start).toBe(2);
    } finally {
      await session.dispose();
    }
  });

  it("8: a violation without a locatable position produces range: undefined, not a real (1,1) range", () => {
    // §6.1: Markuplint reports raw: "" at (1,1) for a violation with no
    // locatable position (e.g. config-error) — the real shape confirmed by
    // the Phase 0 spike (violation-location.spike.test.ts). engine.ts filters
    // config-error/@markuplint/ml-core violations into `failures` before
    // they would ever reach the converter as a diagnostic, so this exercises
    // the real converter directly with that same documented shape to pin
    // down the fallback contract on its own.
    const violations: MLResultInfo["violations"] = [
      {
        ruleId: "some-rule",
        severity: "error",
        message: "no locatable position",
        line: 1,
        col: 1,
        raw: "",
      },
    ];
    const [diagnostic] = toGeneratedDiagnostics(
      "<p>ok</p>",
      violations,
      nullLogger,
    );
    expect(diagnostic?.range).toBeUndefined();
  });

  it("10: distinguishes configuration-error (bad config) from a healthy run", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "bad.json"), "{not valid json");
    await expect(
      markuplintAdapter.createSession({
        workspaceRoot: root,
        settings: { configFile: "bad.json" },
        logger: nullLogger,
      }),
    ).rejects.toMatchObject({
      name: "AdapterSessionFailure",
      failure: { code: "configuration-error" },
    });
  });

  it("10b: a plugin whose create() throws is reported as a configuration-error failure, not an unhandled rejection", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, "broken-plugin.mjs"),
      `export default {
  name: "broken-plugin",
  create() {
    throw new Error("boom from broken-plugin");
  },
};
`,
    );
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({ plugins: [join(root, "broken-plugin.mjs")] }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, "<p>ok</p>"),
      new AbortController().signal,
    );
    await session.dispose();
    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ code: "configuration-error" }),
    ]);
  });

  it("10c: an exec()-time failure (an unresolvable parser module) is reported as an execution-error failure", async () => {
    const root = await tempWorkspace();
    // A parser mapping matching the virtual .html target but pointing at a
    // module that doesn't exist. Markuplint's own config/plugin resolution
    // (provide()'s resolveConfig() call) is defensively wrapped and turns
    // failures into config-error violations instead — but parser resolution
    // runs after that guard and genuinely rejects exec() itself, which is
    // the real (not simulated) trigger for §7's "exec() throws" row.
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({
        parser: { "\\.html$": "vhb-nonexistent-markuplint-parser" },
      }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, "<p>ok</p>"),
      new AbortController().signal,
    );
    await session.dispose();
    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ code: "execution-error" }),
    ]);
  });

  it("11: checks the signal before and after execution", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.validate(request(root, "<p>ok</p>"), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await session.dispose();
  });

  it("11b: aborting mid-validation still rejects with AbortError once the in-flight run resolves", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const controller = new AbortController();
    // validate() runs synchronously up to its first `await` (the pre-check
    // already passed) before this call returns a pending promise; aborting
    // right after starts it "during execution" rather than before (§9.2
    // item 11) — the table's "AbortError after execution completes, if it
    // was already running" case.
    const pending = session.validate(
      request(root, "<p>ok</p>"),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await session.dispose();
  });

  it("12: session dispose is idempotent and rejects further validate() calls", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    await session.dispose();
    await session.dispose();
    await expect(
      session.validate(
        request(root, "<p>ok</p>"),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/disposed/);
  });

  it("12b: disposing a session and creating a fresh one (reconfigure) does not leak stale config state", async () => {
    const root = await tempWorkspace();
    const configPath = join(root, ".markuplintrc.json");
    await writeFile(
      configPath,
      JSON.stringify({ rules: { "id-duplication": true } }),
    );
    const html = '<div id="x"></div><div id="x"></div>';

    const sessionA = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const resultA = await sessionA.validate(
      request(root, html),
      new AbortController().signal,
    );
    expect(resultA.diagnostics.some((d) => d.ruleId === "id-duplication")).toBe(
      true,
    );
    await sessionA.dispose();

    // The language server's reaction to a watched config change is exactly
    // this: dispose the whole session and create a new one
    // (adapter-markuplint.md §4.3: `reconfigure({ invalidateAdapters: [...] })`).
    await writeFile(
      configPath,
      JSON.stringify({ rules: { "id-duplication": false } }),
    );
    const sessionB = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const resultB = await sessionB.validate(
      request(root, html),
      new AbortController().signal,
    );
    await sessionB.dispose();
    expect(resultB.diagnostics.some((d) => d.ruleId === "id-duplication")).toBe(
      false,
    );
  });

  it("13: detects an incompatible Markuplint API shape and reports validator-unavailable", async () => {
    const root = await tempWorkspace();
    const prototype = MLEngine.prototype as unknown as Record<string, unknown>;
    const originalExec = prototype.exec;
    // Simulates a future Markuplint version that renamed/removed exec() —
    // real class, temporarily missing member, restored in `finally`.
    delete prototype.exec;
    try {
      await expect(
        markuplintAdapter.createSession({
          workspaceRoot: root,
          settings: {},
          logger: nullLogger,
        }),
      ).rejects.toMatchObject({
        name: "AdapterSessionFailure",
        failure: { code: "validator-unavailable" },
      });
    } finally {
      prototype.exec = originalExec;
    }
  });

  it("14: configFilePatterns and the committed config-search fixture both match Markuplint's live cosmiconfig search places", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/config-search-filenames.json", import.meta.url),
        "utf8",
      ),
    ) as { searchPlaces: readonly string[] };

    // Drift check (§2, §3.1 item 7): if a Markuplint upgrade changes
    // cosmiconfig's own default search places for the "markuplint" module
    // name, this fails instead of the fixture silently going stale.
    const livePlaces = getDefaultSearchPlaces("markuplint");
    expect([...livePlaces].sort()).toEqual([...fixture.searchPlaces].sort());

    for (const configFilePattern of markuplintAdapter.capabilities
      .configFilePatterns ?? []) {
      const matchesAtLeastOneSearchPlace = fixture.searchPlaces.some((place) =>
        minimatchLike(place, configFilePattern),
      );
      expect(matchesAtLeastOneSearchPlace, configFilePattern).toBe(true);
    }
  });

  it("two SFCs in nested directories resolve different nearest configs", async () => {
    const root = await tempWorkspace();
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(
      join(a, ".markuplintrc.json"),
      JSON.stringify({ rules: { doctype: true } }),
    );
    await writeFile(
      join(b, ".markuplintrc.json"),
      JSON.stringify({ rules: { doctype: false } }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: { profile: "as-configured" },
      logger: nullLogger,
    });
    const resultA = await session.validate(
      request(root, "<html><body>x</body></html>", join(a, "A.vue")),
      new AbortController().signal,
    );
    const resultB = await session.validate(
      request(root, "<html><body>x</body></html>", join(b, "B.vue")),
      new AbortController().signal,
    );
    await session.dispose();
    expect(resultA.diagnostics.some((d) => d.ruleId === "doctype")).toBe(true);
    expect(resultB.diagnostics.some((d) => d.ruleId === "doctype")).toBe(false);
  });

  it("15: getConfigWatchTargets() includes discovered configs and their extends dependencies, and expands deterministically across directories", async () => {
    const root = await tempWorkspace();
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });

    const basePath = join(a, "base.json");
    await writeFile(basePath, JSON.stringify({ rules: { doctype: false } }));
    const configAPath = join(a, ".markuplintrc.json");
    await writeFile(configAPath, JSON.stringify({ extends: ["./base.json"] }));
    const configBPath = join(b, ".markuplintrc.json");
    await writeFile(configBPath, JSON.stringify({ rules: { doctype: false } }));

    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    try {
      await session.validate(
        request(root, "<p>ok</p>", join(a, "A.vue")),
        new AbortController().signal,
      );
      const afterA = session.getConfigWatchTargets?.() ?? [];
      expect(afterA.map((t) => t.absolutePath)).toEqual(
        expect.arrayContaining([configAPath, basePath]),
      );

      await session.validate(
        request(root, "<p>ok</p>", join(b, "B.vue")),
        new AbortController().signal,
      );
      const afterB = session.getConfigWatchTargets?.() ?? [];
      expect(afterB.length).toBeGreaterThan(afterA.length);
      expect(afterB.map((t) => t.absolutePath)).toEqual(
        expect.arrayContaining([configAPath, basePath, configBPath]),
      );
      expect(afterB.every((t) => t.kind === "config")).toBe(true);
      expect(afterB).toEqual(
        [...afterB].sort((x, y) =>
          x.absolutePath.localeCompare(y.absolutePath),
        ),
      );
    } finally {
      await session.dispose();
    }
  });

  it("excludeFiles: an excluded source produces no diagnostics (§6.3, silent per the excludeFiles decision)", async () => {
    const root = await tempWorkspace();
    await writeFile(
      join(root, ".markuplintrc.json"),
      JSON.stringify({ excludeFiles: ["**/*.html"] }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const result = await session.validate(
      request(root, '<img src="a.png">'),
      new AbortController().signal,
    );
    await session.dispose();
    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.metadata).toMatchObject({ excluded: true });
  });
});

function minimatchLike(filename: string, glob: string): boolean {
  if (glob === "**/package.json") return filename === "package.json";
  if (glob === "**/.markuplintrc") return filename === ".markuplintrc";
  if (glob === "**/.markuplintrc.*")
    return /^\.markuplintrc\..+$/.test(filename);
  if (glob === "**/.config/markuplintrc")
    return filename === ".config/markuplintrc";
  if (glob === "**/.config/markuplintrc.*")
    return /^\.config\/markuplintrc\..+$/.test(filename);
  if (glob === "**/markuplint.config.*")
    return /^markuplint\.config\..+$/.test(filename);
  return false;
}

describe("createAdapterContractCases smoke", () => {
  it("exposes cases without executing them (sanity for the vitest binding above)", () => {
    expect(createAdapterContractCases(contractFixture).length).toBeGreaterThan(
      0,
    );
  });
});
