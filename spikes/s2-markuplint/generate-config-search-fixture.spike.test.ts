// Spike S2 criterion 7 (adapter-markuplint.md §3.1 item 7, §2, §9.2 item 14): record
// the installed Markuplint version's config-search filename list as a fixture, so
// `capabilities.configFilePatterns` can be asserted against it (a version update that
// adds/removes a search target then fails a test instead of drifting silently).
//
// Finding: `@markuplint/file-resolver`'s `cosmiconfig.js` calls
// `cosmiconfig('markuplint', { searchStrategy: 'project', loaders: {...} })` with NO
// `searchPlaces` override, so the real search-filename list is exactly cosmiconfig's
// own default list for moduleName "markuplint" (`getDefaultSearchPlaces` in
// `cosmiconfig/dist/defaults.js`) — read here directly from the installed package,
// not hand-copied.
//
// This list is LARGER than adapter-markuplint.md §2's current
// `capabilities.configFilePatterns` (`**/.markuplintrc`, `**/.markuplintrc.*`,
// `**/markuplint.config.*`, `**/package.json`): cosmiconfig also searches a
// `.config/` subdirectory (`.config/markuplintrc`, `.config/markuplintrc.json`, ...,
// `.config/markuplintrc.mjs`), none of which any of the four documented globs match
// (a bare `.config/markuplintrc.js` has no leading dot on its own filename, so
// `**/.markuplintrc.*` does not match it either). See FINDINGS.md — this is a real
// gap to fix in adapter-markuplint.md §2 as part of ADR-0003's design-doc update.
//
// The upward-search behavior itself (an explicit configFile bypasses search; with no
// configFile and noSearchConfig !== true, MLEngine searches from `dirname` upward
// through parent directories, matching a `.config/markuplintrc.json`) is verified
// empirically below against a real temp directory tree.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MLEngine } from "markuplint";
import { getDefaultSearchPlaces } from "cosmiconfig";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(
  here,
  "../../packages/adapter-markuplint/fixtures/config-search-filenames.json",
);

// adapter-markuplint.md §2's current documented globs, for the drift comparison.
const DOCUMENTED_CONFIG_FILE_PATTERNS = [
  "**/.markuplintrc",
  "**/.markuplintrc.*",
  "**/markuplint.config.*",
  "**/package.json",
];

function minimatchLike(filename: string, glob: string): boolean {
  // Cheap check sufficient for this fixture: only the four documented glob shapes
  // above appear, all of the form "**/<literal-or-suffix>". Good enough to flag
  // real mismatches without pulling in a matcher dependency.
  if (glob === "**/package.json") return filename === "package.json";
  if (glob === "**/.markuplintrc") return filename === ".markuplintrc";
  if (glob === "**/.markuplintrc.*")
    return /^\.markuplintrc\..+$/.test(filename);
  if (glob === "**/markuplint.config.*")
    return /^markuplint\.config\..+$/.test(filename);
  throw new Error(`unhandled glob shape in this cheap matcher: ${glob}`);
}

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("S2 criterion 7: config-search filename fixture", () => {
  it("writes packages/adapter-markuplint/fixtures/config-search-filenames.json from the real installed cosmiconfig defaults, and flags any gap against the documented configFilePatterns", async () => {
    const searchPlaces = getDefaultSearchPlaces("markuplint");
    expect(searchPlaces.length).toBeGreaterThan(0);
    expect(searchPlaces).toContain("package.json");
    expect(searchPlaces).toContain(".markuplintrc");

    const unmatchedByDocumentedPatterns = searchPlaces.filter(
      (filename) =>
        !DOCUMENTED_CONFIG_FILE_PATTERNS.some((glob) =>
          minimatchLike(filename, glob),
        ),
    );
    // Real finding: the `.config/*` search places are not covered by any of the
    // four documented globs. If a future Markuplint version removes this gap
    // (e.g. by dropping .config/ support) this assertion should be revisited —
    // it's here to make the current, real gap visible, not to freeze it forever.
    expect(unmatchedByDocumentedPatterns).toEqual(
      searchPlaces.filter((f) => f.startsWith(".config/")),
    );

    const fixture = {
      markuplintVersion: (await import("markuplint")).version,
      cosmiconfigModuleName: "markuplint",
      searchStrategy: "project",
      searchPlaces,
      documentedConfigFilePatterns: DOCUMENTED_CONFIG_FILE_PATTERNS,
      unmatchedByDocumentedPatterns,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(fixture, null, 2)}\n`,
      "utf8",
    );
  });

  it("empirically confirms upward search finds a .config/markuplintrc.json two directories up when no explicit configFile is given", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vhb-s2-config-search-"));
    tempDirs.push(root);
    await mkdir(path.join(root, ".config"), { recursive: true });
    await writeFile(
      path.join(root, ".config", "markuplintrc.json"),
      JSON.stringify({ rules: { "id-duplication": true } }),
      "utf8",
    );
    const nested = path.join(root, "src", "components");
    await mkdir(nested, { recursive: true });

    // No configFile, no noSearchConfig -> MLEngine searches upward from `dirname`.
    const engine = await MLEngine.fromCode(
      '<div id="dup"></div><div id="dup"></div>',
      {
        name: "Widget.vue.__vue_html_bridge__/variant-1.html",
        dirname: nested,
      },
    );
    const result = await engine.exec();
    await engine.close();

    expect(result?.violations.some((v) => v.ruleId === "id-duplication")).toBe(
      true,
    );
  });
});
