// Spike S2 (implementation-plan.md §3.2, adapter-markuplint.md §3.1 criteria 1, 2, 3, 5).
//
// Proves the real public API of the installed `markuplint@4.18.3` package, replacing
// adapter-markuplint.md §3's conceptual `MLEngine`/`createInMemoryMlFile` sample code.
// The real entry point is `MLEngine.fromCode(sourceCode, options)`, which builds an
// in-memory `MLFile` via `resolveFiles([{ sourceCode, name, workspace }])` — no
// filesystem write ever happens for a `{ sourceCode, name }` target
// (see @markuplint/file-resolver's `MLFile` — `_type` is `'code-base'`, and
// `getCode()` returns the in-memory string directly).
//
// Key finding for criterion 1 / the sourceFilename-vs-virtualFilename question
// (monorepo.md §15, adapter-markuplint.md §4.2): `MLFile.path` is computed as
// `path.resolve(dirname, basename)`, where `dirname`/`basename` come from
// `workspace`/`name`. If `name` is passed as an ABSOLUTE path and `workspace` is
// omitted, `file.path` equals that absolute path exactly, independent of `cwd` or
// any real directory. `overrides`/`parser`/`excludeFiles` matching is evaluated
// against `file.path` (via `MLFile#matches`/`#ignored`), so passing the documented
// synthetic `virtualFilename` format (validator-api §3.2) as an absolute `name`
// gives full, unambiguous control over override matching, decoupled from the real
// `sourceFilename` directory — exactly the separation adapter-markuplint.md §4.2
// requires. Config *search* is irrelevant to this path because production usage
// always resolves the config separately (§4.1) and passes it explicitly with
// `noSearchConfig: true` — see generate-config-search-fixture.spike.test.ts for the
// separate auto-search behavior.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MLEngine } from "markuplint";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(here, "fixtures/bridge-config.json");

/** Mirrors validator-api §3.2's `…/<source>.__vue_html_bridge__/variant-<hash>.html` shape. */
function virtualFilename(sourceAbsPath: string, variantHash: string): string {
  return path.join(
    path.dirname(sourceAbsPath),
    `${path.basename(sourceAbsPath)}.__vue_html_bridge__`,
    `variant-${variantHash}.html`,
  );
}

describe("S2 criterion 1: in-memory validation, no filesystem write", () => {
  it("validates an HTML string under an arbitrary absolute virtual .html filename that does not exist on disk", async () => {
    const sourceAbsPath = "/workspace/src/components/LoggedIn.vue";
    const virtualName = virtualFilename(sourceAbsPath, "abc123");
    expect(
      virtualName.endsWith(".__vue_html_bridge__/variant-abc123.html"),
    ).toBe(true);

    const engine = await MLEngine.fromCode(
      '<button aria-pressed="dummy-string"></button>',
      { name: virtualName, configFile, noSearchConfig: true, fix: false },
    );
    const result = await engine.exec();
    await engine.close();

    expect(result).not.toBeNull();
    // The virtual path is echoed back verbatim; nothing was written under it.
    expect(result?.filePath).toBe(virtualName);
    const { access } = await import("node:fs/promises");
    await expect(access(virtualName)).rejects.toThrow();
    // aria-pressed="dummy-string" is not a valid ARIA state token -> the wai-aria rule
    // fires, proving the virtual file was actually parsed and linted, not silently skipped.
    expect(result?.violations.some((v) => v.ruleId === "wai-aria")).toBe(true);
  });
});

describe("S2 criterion 2: extends / plugins / rules / nodeRules resolve from an explicit config", () => {
  it("applies extends (markuplint:recommended-static-html), a top-level rule, and a nodeRule from bridge-config.json", async () => {
    const virtualName = virtualFilename(
      "/workspace/src/components/Gallery.vue",
      "def456",
    );
    // Two violations expected:
    // - id-duplication (top-level `rules`, explicitly turned on by our config)
    // - required-attr (nodeRule: img must have alt)
    const engine = await MLEngine.fromCode(
      '<img id="x" src="a.png"><img id="x" src="b.png">',
      { name: virtualName, configFile, noSearchConfig: true },
    );
    const result = await engine.exec();
    await engine.close();

    const ruleIds = (result?.violations ?? []).map((v) => v.ruleId);
    expect(ruleIds).toContain("id-duplication");
    expect(ruleIds).toContain("required-attr");
    // `extends: markuplint:recommended-static-html` pulls in `character-reference`
    // and `end-tag` on top of the (empty) code-styles preset — confirm the extend
    // chain actually resolved by checking a rule that only recommended-static-html
    // (not our explicit `rules` block) turns on: end-tag requires explicit closing
    // tags for non-void elements.
    const engine2 = await MLEngine.fromCode("<div>", {
      name: virtualFilename("/workspace/src/components/Gallery.vue", "ghi789"),
      configFile,
      noSearchConfig: true,
    });
    const result2 = await engine2.exec();
    await engine2.close();
    expect(result2?.violations.some((v) => v.ruleId === "end-tag")).toBe(true);
  });
});

describe("S2 criterion 3: Vue parser mapping in config does not apply to the virtual .html", () => {
  it("does not attempt to load @markuplint/vue-parser (not installed) even though the config maps \\.vue$ to it", async () => {
    // bridge-config.json's `parser` maps `\.vue$` -> "@markuplint/vue-parser", which
    // is NOT installed in this spike workspace. If the mapping applied to our
    // `.html`-suffixed virtual filename, resolving that parser would throw a
    // module-not-found error. It must not, because the mapping is a regex tested
    // against the virtual filename, which never matches `\.vue$`.
    const virtualName = virtualFilename(
      "/workspace/src/components/Plain.vue",
      "jkl012",
    );
    const engine = await MLEngine.fromCode("<p>hello</p>", {
      name: virtualName,
      configFile,
      noSearchConfig: true,
    });
    await expect(engine.exec()).resolves.not.toBeNull();
    await engine.close();
  });
});

describe("S2 criterion 5: engine/config reuse and concurrency safety", () => {
  it("resolves config once and can be reused via setCode() for repeated validation of the same logical target", async () => {
    const virtualName = virtualFilename(
      "/workspace/src/components/Reuse.vue",
      "reuse01",
    );
    const engine = await MLEngine.fromCode('<img src="a.png">', {
      name: virtualName,
      configFile,
      noSearchConfig: true,
    });
    const first = await engine.exec();
    expect(first?.violations.some((v) => v.ruleId === "required-attr")).toBe(
      true,
    );

    // setCode() re-parses without re-resolving config (see ml-engine.js `setCode`).
    await engine.setCode('<img src="a.png" alt="a cat">');
    const second = await engine.exec();
    expect(second?.violations.some((v) => v.ruleId === "required-attr")).toBe(
      false,
    );
    await engine.close();
  });

  it("runs concurrent validations against independent MLEngine instances safely (no cross-talk)", async () => {
    const inputs = Array.from({ length: 8 }, (_, i) => ({
      html: i % 2 === 0 ? '<img src="a.png">' : '<img src="a.png" alt="ok">',
      name: virtualFilename(
        `/workspace/src/components/Concurrent${i}.vue`,
        `c${i}`,
      ),
    }));

    const results = await Promise.all(
      inputs.map(async ({ html, name }) => {
        const engine = await MLEngine.fromCode(html, {
          name,
          configFile,
          noSearchConfig: true,
        });
        const result = await engine.exec();
        await engine.close();
        return { name, result };
      }),
    );

    for (const [i, { name, result }] of results.entries()) {
      expect(result?.filePath).toBe(name); // no identity cross-talk between concurrent engines
      const hasRequiredAttr = result?.violations.some(
        (v) => v.ruleId === "required-attr",
      );
      expect(hasRequiredAttr).toBe(i % 2 === 0);
    }
  });
});

describe("fixture sanity", () => {
  it("bridge-config.json parses as valid JSON (guards against a broken fixture masking real findings)", async () => {
    const raw = await readFile(configFile, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
