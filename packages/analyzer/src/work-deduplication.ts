// Work item construction (analyzer.md §5.1-§5.2): HTML-hash dedup within one
// adapter, and the normative virtualFilename derivation.
import { createHash } from "node:crypto";
import type { HtmlVariant } from "vue-html-bridge";

export interface ValidationWorkItem {
  adapterId: string;
  htmlHash: string;
  html: string;
  virtualFilename: string;
  representativeVariantId: string;
  memberVariantIds: readonly string[];
}

/** UTF-16-content hash, hex-encoded so it is always a safe path segment. */
export function hashHtml(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex").slice(0, 16);
}

export function virtualFilename(
  sourceFilename: string,
  htmlHash: string,
): string {
  return `${sourceFilename}.__vue_html_bridge__/variant-${htmlHash}.html`;
}

export interface VariantHtmlGroup {
  html: string;
  hash: string;
  variantIds: readonly string[];
}

/** Groups variants sharing identical HTML content, keyed by content hash. */
export function groupVariantsByHtml(
  variants: readonly HtmlVariant[],
): readonly VariantHtmlGroup[] {
  const byHtml = new Map<
    string,
    { html: string; hash: string; variantIds: string[] }
  >();
  for (const variant of variants) {
    const hash = hashHtml(variant.html);
    const existing = byHtml.get(hash);
    if (existing) {
      existing.variantIds.push(variant.id);
    } else {
      byHtml.set(hash, { html: variant.html, hash, variantIds: [variant.id] });
    }
  }
  return [...byHtml.values()];
}

/**
 * Groups variants sharing identical HTML into one work item per adapter.
 * Deliberately not shared across adapters (§5.1): each adapter gets its own
 * work-item list, even for the same HTML content.
 */
export function buildWorkItems(
  sourceFilename: string,
  variants: readonly HtmlVariant[],
  adapterIds: readonly string[],
): readonly ValidationWorkItem[] {
  const groups = groupVariantsByHtml(variants);
  const items: ValidationWorkItem[] = [];
  for (const adapterId of adapterIds) {
    for (const group of groups) {
      items.push({
        adapterId,
        htmlHash: group.hash,
        html: group.html,
        virtualFilename: virtualFilename(sourceFilename, group.hash),
        representativeVariantId: group.variantIds[0]!,
        memberVariantIds: group.variantIds,
      });
    }
  }
  return items;
}
