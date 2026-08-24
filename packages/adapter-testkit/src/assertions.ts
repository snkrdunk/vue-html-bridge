/**
 * Small, framework-neutral helpers shared by the contract cases in
 * `contract.ts`. Kept in their own module (design doc §9's proposed layout)
 * so each has a single, independently reviewable responsibility.
 */

/**
 * Recursively normalizes `value` the way `JSON.stringify` would: properties
 * whose value is `undefined` are dropped rather than compared against a
 * missing key (matching `toEqual`-style "undefined === absent" semantics),
 * while anything that cannot round-trip through JSON at all — a `BigInt`, a
 * `Function`, a `Symbol`, an `Error` instance, a non-finite `number`, a
 * circular reference, or a non-plain class instance — throws a descriptive
 * error instead of silently losing data (design doc §3.9).
 */
export function normalizeForJson(
  value: unknown,
  seen: Set<unknown> = new Set(),
): unknown {
  if (value === undefined || value === null) return value;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `value contains a non-finite number (${String(value)}), which is not JSON safe`,
      );
    }
    return value;
  }
  if (type === "bigint") {
    throw new Error("value contains a BigInt, which is not JSON safe");
  }
  if (type === "function") {
    throw new Error("value contains a function, which is not JSON safe");
  }
  if (type === "symbol") {
    throw new Error("value contains a symbol, which is not JSON safe");
  }
  if (value instanceof Error) {
    throw new Error(
      `value contains an Error instance ("${value.message}"), which is not JSON safe`,
    );
  }
  if (typeof value !== "object") {
    throw new Error(
      `value contains an unsupported ${type}, which is not JSON safe`,
    );
  }
  if (seen.has(value)) {
    throw new Error(
      "value contains a circular reference, which is not JSON safe",
    );
  }
  // `seen` tracks the current ancestor chain (a DFS stack), not "every value
  // visited anywhere" — a value reachable via two different, non-nested
  // paths (e.g. two properties pointing at the same shared object) is not
  // circular and must be allowed, so it's removed again once its own
  // subtree has been fully normalized.
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForJson(item, seen));
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      const ctorName =
        (value as { constructor?: { name?: string } }).constructor?.name ??
        "non-plain object";
      throw new Error(
        `value contains a ${ctorName} class instance, which is not a plain JSON object`,
      );
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (entry === undefined) continue;
      result[key] = normalizeForJson(entry, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * Structural equality between two values, comparing their normalized JSON
 * representations (see {@link normalizeForJson}) rather than raw
 * `JSON.stringify` output, so a literal `undefined` property does not cause
 * a mismatch against an equivalent object where that key is simply absent.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(normalizeForJson(a)) === JSON.stringify(normalizeForJson(b))
  );
}
