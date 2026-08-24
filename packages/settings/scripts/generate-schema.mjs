#!/usr/bin/env node
// Regenerates the committed `schema.json` golden fixture (settings.md §7)
// from this package's own definition (src/json-schema.ts). Run
// `pnpm run build` first — this imports the built `dist/json-schema.js`,
// matching the "plain tsc, no bundler" tooling policy (ADR-0001) rather
// than adding a ts-node/tsx dependency just for this one script.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeSettingsJsonSchema } from "../dist/json-schema.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = resolve(packageRoot, "schema.json");

writeFileSync(outputPath, serializeSettingsJsonSchema());
console.log(`Wrote ${outputPath}`);
