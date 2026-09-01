// Core result cache (analyzer.md §10.1): keyed by source hash + filename +
// core/compiler versions + normalized GenerateOptions + TS project epoch.
// A cache hit is trusted on the key alone — the cached GenerateResult is
// never re-compared against a freshly computed one — so a hash collision
// would silently serve a stale/wrong result. This is a documented reliance
// on SHA-256 being collision-resistant, not an oversight.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { GenerateOptions, GenerateResult } from "vue-html-bridge";
import { normalizeFilenameForCacheKey } from "./filename-key.js";
import { BoundedLruCache, type BoundedCacheOptions } from "./lru.js";

const require = createRequire(import.meta.url);
// Read once: the running core package's own version stands in for
// "core/compiler versions" — its own dependency versions are covered
// transitively by core's semver discipline.
const CORE_VERSION = (
  require("vue-html-bridge/package.json") as { version: string }
).version;

export interface GenerationCacheKeyInput {
  source: string;
  filename: string;
  generateOptions: GenerateOptions | undefined;
  epoch: number;
}

export function generationCacheKey(input: GenerationCacheKeyInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceHash: hashContent(input.source),
        filename: normalizeFilenameForCacheKey(input.filename),
        coreVersion: CORE_VERSION,
        generateOptions: normalizeGenerateOptions(input.generateOptions),
        epoch: input.epoch,
      }),
    )
    .digest("hex");
}

function normalizeGenerateOptions(
  options: GenerateOptions | undefined,
): unknown {
  if (!options) return null;
  return {
    warnVariantCount: options.warnVariantCount ?? null,
    customElements: [...(options.customElements ?? [])].sort(),
    // Sound, not just deterministic: core rejects camelized-duplicate
    // `customDirectives` mappings outright (generate.ts, plan.md §1 v3), so
    // there is no wins-rule an order-insensitive key could conflate two
    // differently-behaving options objects onto (core.md's "normalized
    // GenerateOptions" cache-key contract).
    customDirectives: [...(options.customDirectives ?? [])]
      .map((mapping) => ({
        name: mapping.name,
        attributes: sortObjectEntries(mapping.attributes),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function sortObjectEntries(
  record: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  return Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function hashContent(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function approximateGenerateResultBytes(result: GenerateResult): number {
  let total = 0;
  for (const variant of result.variants) {
    total += variant.html.length;
    total += variant.map.length * 64;
  }
  total += result.diagnostics.length * 128;
  return total;
}

export function createGenerationCache(
  options: BoundedCacheOptions,
): BoundedLruCache<GenerateResult> {
  return new BoundedLruCache<GenerateResult>(options);
}
