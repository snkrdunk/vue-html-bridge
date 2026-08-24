import { describe, expect, it } from "vitest";
import { BoundedLruCache } from "./lru.js";

describe("BoundedLruCache", () => {
  it("evicts the least-recently-used entry once maxEntries is exceeded", () => {
    const cache = new BoundedLruCache<string>({
      maxEntries: 2,
      maxApproximateBytes: 1_000_000,
    });
    cache.set("a", "A", 1);
    cache.set("b", "B", 1);
    cache.set("c", "C", 1); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
    expect(cache.size).toBe(2);
  });

  it("get() refreshes recency, protecting a just-read entry from eviction", () => {
    const cache = new BoundedLruCache<string>({
      maxEntries: 2,
      maxApproximateBytes: 1_000_000,
    });
    cache.set("a", "A", 1);
    cache.set("b", "B", 1);
    cache.get("a"); // "a" is now more recent than "b"
    cache.set("c", "C", 1); // evicts "b", not "a"
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("C");
  });

  it("evicts by approximate byte size even under the entry-count limit", () => {
    const cache = new BoundedLruCache<string>({
      maxEntries: 100,
      maxApproximateBytes: 10,
    });
    cache.set("a", "A", 6);
    cache.set("b", "B", 6); // total would be 12 > 10, evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
  });

  it("re-setting an existing key updates its value and byte accounting without duplicating it", () => {
    const cache = new BoundedLruCache<string>({
      maxEntries: 5,
      maxApproximateBytes: 5,
    });
    cache.set("a", "A1", 5);
    cache.set("a", "A2", 5);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe("A2");
  });

  it("delete() and clear() remove entries and their byte accounting", () => {
    const cache = new BoundedLruCache<string>({
      maxEntries: 5,
      maxApproximateBytes: 10,
    });
    cache.set("a", "A", 5);
    cache.set("b", "B", 5);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(1);
    // With "a"'s bytes correctly reclaimed, a second 5-byte entry fits.
    cache.set("c", "C", 5);
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("b")).toBeUndefined();
  });
});
