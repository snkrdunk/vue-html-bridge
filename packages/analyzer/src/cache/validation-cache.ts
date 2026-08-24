// Adapter result cache (analyzer.md §10.2): keyed by settings hash +
// sourceFilename + HTML content hash. The cache instance itself already
// belongs to one adapter session (a fresh instance is created per session,
// see sessions.ts), so the key does not need to separately carry adapter
// id/version or settings hash — recreating the session already discards the
// whole cache, and every entry in one instance shares one adapter/settings
// pair by construction. Settings hash is still folded in, matching the
// design doc's key literally, in case a session is ever reused in a way
// that changes settings without recreation.
import type { ValidateHtmlResult } from "@vue-html-bridge/validator-api";
import { stableHash } from "../occurrence.js";
import { normalizeFilenameForCacheKey } from "./filename-key.js";
import { BoundedLruCache, type BoundedCacheOptions } from "./lru.js";

export interface ValidationCacheKeyInput {
  settingsHash: string;
  sourceFilename: string;
  htmlHash: string;
}

export function validationCacheKey(input: ValidationCacheKeyInput): string {
  return `${input.settingsHash}:${normalizeFilenameForCacheKey(input.sourceFilename)}:${input.htmlHash}`;
}

export function hashSettings(settings: unknown): string {
  return stableHash(settings);
}

export function approximateValidationResultBytes(
  result: ValidateHtmlResult,
): number {
  let total = 0;
  for (const diagnostic of result.diagnostics) {
    total += diagnostic.message.length + 96;
  }
  total += result.failures.length * 128;
  return total;
}

export function createValidationCache(
  options: BoundedCacheOptions,
): BoundedLruCache<ValidateHtmlResult> {
  return new BoundedLruCache<ValidateHtmlResult>(options);
}
