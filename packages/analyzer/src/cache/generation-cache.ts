// Core result cache (analyzer.md §10.1): keyed by source hash + filename +
// core/compiler versions + normalized GenerateOptions + TS project epoch.
// A cache hit is trusted on the key alone — the cached GenerateResult is
// never re-compared against a freshly computed one — so a hash collision
// would silently serve a stale/wrong result. This is a documented reliance
// on SHA-256 being collision-resistant, not an oversight.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  DecisionAssignment,
  GenerateOptions,
  GenerateResult,
  GeneratedValueProvenance,
  HtmlVariant,
  JsonValue,
  MappingEntry,
  SourceRange,
} from "vue-html-bridge";
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

/** A generic small-object's V8 overhead — the same rough unit the original
 * estimate already used for a `MappingEntry` (`* 64`); reused here for every
 * nested object so a file with many variants can't hide real heap behind an
 * uncounted field. */
const OBJECT_OVERHEAD_BYTES = 64;

/**
 * `html`/`diagnostics` were already counted; `decisions` and `map` scale
 * with variant count exactly like `html` does but were previously left out
 * (`decisions`) or flattened to a fixed guess that ignored their nested
 * `provenance`/`sourceRange` payload (`map`). Undercounting either lets a
 * file with a very large variant count retain far more real heap than
 * `maxApproximateBytes` intends — the LRU's count cap alone won't evict it
 * until hundreds of *other* files have since been analyzed.
 */
export function approximateGenerateResultBytes(result: GenerateResult): number {
  let total = 0;
  for (const variant of result.variants) {
    total += approximateVariantBytes(variant);
  }
  total += result.diagnostics.length * 128;
  return total;
}

function approximateVariantBytes(variant: HtmlVariant): number {
  let total = variant.html.length + OBJECT_OVERHEAD_BYTES;
  for (const decision of variant.decisions) {
    total += approximateDecisionBytes(decision);
  }
  for (const entry of variant.map) {
    total += approximateMappingEntryBytes(entry);
  }
  return total;
}

function approximateDecisionBytes(decision: DecisionAssignment): number {
  return (
    OBJECT_OVERHEAD_BYTES +
    decision.decisionId.length +
    decision.displayName.length +
    approximateJsonValueBytes(decision.value)
  );
}

function approximateJsonValueBytes(value: JsonValue): number {
  if (typeof value === "string") return value.length + OBJECT_OVERHEAD_BYTES;
  if (typeof value !== "object" || value === null) {
    return OBJECT_OVERHEAD_BYTES;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, item) => sum + approximateJsonValueBytes(item),
      OBJECT_OVERHEAD_BYTES,
    );
  }
  return Object.entries(value).reduce(
    (sum, [key, item]) => sum + key.length + approximateJsonValueBytes(item),
    OBJECT_OVERHEAD_BYTES,
  );
}

function approximateMappingEntryBytes(entry: MappingEntry): number {
  return (
    OBJECT_OVERHEAD_BYTES + // generated range + kind
    approximateSourceRangeBytes(entry.source) +
    approximateProvenanceBytes(entry.provenance)
  );
}

function approximateSourceRangeBytes(range: SourceRange): number {
  return range.filename.length + OBJECT_OVERHEAD_BYTES;
}

function approximateProvenanceBytes(
  provenance: GeneratedValueProvenance,
): number {
  const base =
    OBJECT_OVERHEAD_BYTES + approximateSourceRangeBytes(provenance.sourceRange);
  switch (provenance.kind) {
    case "finite-domain":
      return base + provenance.decisionId.length;
    case "synthetic":
      return base + provenance.transformation.length;
    case "sentinel":
      return (
        base + provenance.reason.length + (provenance.originalType?.length ?? 0)
      );
    case "source-literal":
      return base;
  }
}

export function createGenerationCache(
  options: BoundedCacheOptions,
): BoundedLruCache<GenerateResult> {
  return new BoundedLruCache<GenerateResult>(options);
}
