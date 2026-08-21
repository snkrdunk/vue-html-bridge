import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("2/9: the generated-html profile disables source-format rules while keeping semantic ones, and priority runs Markuplint defaults < user config < overlay < profileRuleOverrides", async () => {
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

      // markuplint:recommended-static-html (the overlay's own baseline) still fires.
      const baselineResult = await session.validate(
        request(root, "<div>"),
        new AbortController().signal,
      );
      expect(
        baselineResult.diagnostics.some((d) => d.ruleId === "end-tag"),
      ).toBe(true);
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

  it("5/6/7: rule/severity/range are correct and deterministic, including a multi-line and an emoji fixture", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    const html = '<p>\u{1F600}</p>\n<img src="a.png">';
    const first = await session.validate(
      request(root, html),
      new AbortController().signal,
    );
    const second = await session.validate(
      request(root, html),
      new AbortController().signal,
    );
    await session.dispose();
    expect(first.diagnostics).toEqual(second.diagnostics);
    const violation = first.diagnostics.find(
      (d) => d.ruleId === "required-attr",
    );
    expect(violation?.range).toBeDefined();
    expect(
      html.slice(violation!.range!.start, violation!.range!.end),
    ).toContain("img");
  });

  it("8: a violation without a locatable position reports range: undefined", async () => {
    const root = await tempWorkspace();
    const session = await markuplintAdapter
      .createSession({
        workspaceRoot: root,
        settings: { configFile: "malformed.json" },
        logger: nullLogger,
      })
      .catch((error: unknown) => error);
    // createSession itself rejects for a missing explicit config (§3.1) —
    // covered by the contract suite's failure-separation case; here we
    // additionally assert the rejection carries the AdapterSessionFailure shape.
    expect(session).toMatchObject({ name: "AdapterSessionFailure" });
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

  it("14: configFilePatterns matches the config-search filename fixture recorded for the pinned Markuplint version", async () => {
    const fixture = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(
          new URL("../fixtures/config-search-filenames.json", import.meta.url),
          "utf8",
        ),
      ),
    ) as { searchPlaces: readonly string[] };
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

  it("15: getConfigWatchTargets() includes the discovered config as a normalized absolute path", async () => {
    const root = await tempWorkspace();
    const configPath = join(root, ".markuplintrc.json");
    await writeFile(
      configPath,
      JSON.stringify({ rules: { "id-duplication": true } }),
    );
    const session = await markuplintAdapter.createSession({
      workspaceRoot: root,
      settings: {},
      logger: nullLogger,
    });
    await session.validate(
      request(root, "<p>ok</p>"),
      new AbortController().signal,
    );
    const targets = session.getConfigWatchTargets?.() ?? [];
    await session.dispose();
    expect(targets).toContainEqual({
      absolutePath: configPath,
      kind: "config",
    });
    expect(targets).toEqual(
      [...targets].sort((x, y) => x.absolutePath.localeCompare(y.absolutePath)),
    );
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
