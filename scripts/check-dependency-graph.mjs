#!/usr/bin/env node
// Enforces monorepo.md §4.1's dependency direction: no cycles, core depends on
// nothing internal, and nothing depends on cli. Run via `pnpm run check:deps`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(repoRoot, "packages");

// The Stage A subset of monorepo.md §4.1: `@vue-html-bridge/adapter-loader` is
// scaffolded in Phase 3 (implementation-plan.md §6 task 3), so its edges to
// language-server and cli are intentionally absent here. Update this map when
// a new package is scaffolded or its declared dependencies change.
const EXPECTED_INTERNAL_DEPS = {
  "vue-html-bridge": [],
  "@vue-html-bridge/validator-api": [],
  // "vue-html-bridge" here is a devDependency-only edge (settings.md §2, §8
  // item 8): a contract test type-checks this package's structurally
  // declared `GenerateOptions` against core's real one via a type-only
  // import, erased at build time. It adds no runtime dependency — the same
  // pattern as adapter-markuplint's devDependency-only edge onto
  // adapter-testkit below.
  "@vue-html-bridge/settings": ["vue-html-bridge"],
  "@vue-html-bridge/analyzer": [
    "vue-html-bridge",
    "@vue-html-bridge/adapter-testkit",
    "@vue-html-bridge/validator-api",
  ],
  "@vue-html-bridge/adapter-markuplint": [
    "@vue-html-bridge/adapter-testkit",
    "@vue-html-bridge/validator-api",
  ],
  "@vue-html-bridge/adapter-testkit": ["@vue-html-bridge/validator-api"],
  "@vue-html-bridge/language-server": [
    "@vue-html-bridge/analyzer",
    "@vue-html-bridge/adapter-markuplint",
    "@vue-html-bridge/adapter-testkit",
    "@vue-html-bridge/validator-api",
    "@vue-html-bridge/settings",
  ],
  "@vue-html-bridge/cli": [
    "@vue-html-bridge/analyzer",
    "@vue-html-bridge/adapter-markuplint",
    "@vue-html-bridge/validator-api",
    "@vue-html-bridge/settings",
  ],
};

const CORE_PACKAGE = "vue-html-bridge";
const CLI_PACKAGE = "@vue-html-bridge/cli";

function readWorkspacePackages() {
  const graph = new Map();
  for (const dirName of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dirName, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    const internalDeps = Object.entries(deps)
      .filter(
        ([, version]) =>
          typeof version === "string" && version.startsWith("workspace:"),
      )
      .map(([name]) => name)
      .sort();
    graph.set(manifest.name, internalDeps);
  }
  return graph;
}

function findCycle(graph) {
  const state = new Map(); // name -> "visiting" | "done"
  const stack = [];

  function visit(name) {
    if (state.get(name) === "done") return null;
    if (state.get(name) === "visiting") {
      const cycleStart = stack.indexOf(name);
      return [...stack.slice(cycleStart), name];
    }
    state.set(name, "visiting");
    stack.push(name);
    for (const dep of graph.get(name) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, "done");
    return null;
  }

  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

function main() {
  const graph = readWorkspacePackages();
  const errors = [];

  const cycle = findCycle(graph);
  if (cycle) {
    errors.push(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const coreDeps = graph.get(CORE_PACKAGE) ?? [];
  if (coreDeps.length > 0) {
    errors.push(
      `"${CORE_PACKAGE}" must depend on nothing internal, found: ${coreDeps.join(", ")}`,
    );
  }

  for (const [name, deps] of graph) {
    if (name !== CLI_PACKAGE && deps.includes(CLI_PACKAGE)) {
      errors.push(`"${name}" must not depend on "${CLI_PACKAGE}"`);
    }
  }

  for (const [name, expected] of Object.entries(EXPECTED_INTERNAL_DEPS)) {
    if (!graph.has(name)) {
      errors.push(
        `Expected workspace package "${name}" was not found under packages/*`,
      );
      continue;
    }
    const actual = graph.get(name);
    const expectedSorted = [...expected].sort();
    const same =
      actual.length === expectedSorted.length &&
      actual.every((dep, i) => dep === expectedSorted[i]);
    if (!same) {
      errors.push(
        `"${name}" internal deps ${JSON.stringify(actual)} do not match monorepo.md §4.1 ` +
          `(expected ${JSON.stringify(expectedSorted)})`,
      );
    }
  }

  for (const name of graph.keys()) {
    if (!(name in EXPECTED_INTERNAL_DEPS)) {
      errors.push(
        `"${name}" is not registered in EXPECTED_INTERNAL_DEPS — add it to scripts/check-dependency-graph.mjs`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("Dependency-direction lint failed:\n");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(
    `Dependency-direction lint passed for ${graph.size} workspace packages.`,
  );
}

main();
