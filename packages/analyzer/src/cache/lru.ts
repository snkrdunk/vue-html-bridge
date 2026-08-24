// A size-and-count-bounded, in-memory LRU cache (analyzer.md §10.3): the
// workspace-scoped core-result and adapter-result caches are both instances
// of this. Map iteration order is insertion order, and re-inserting a key on
// access keeps it "most recent", so the first key in iteration order is
// always the least-recently-used one to evict.
export interface BoundedCacheOptions {
  maxEntries: number;
  maxApproximateBytes: number;
}

interface CacheRecord<TValue> {
  value: TValue;
  approximateBytes: number;
}

export class BoundedLruCache<TValue> {
  private readonly entries = new Map<string, CacheRecord<TValue>>();
  private approximateBytes = 0;

  constructor(private readonly options: BoundedCacheOptions) {}

  get(key: string): TValue | undefined {
    const record = this.entries.get(key);
    if (!record) return undefined;
    this.entries.delete(key);
    this.entries.set(key, record);
    return record.value;
  }

  set(key: string, value: TValue, approximateBytes: number): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.approximateBytes -= existing.approximateBytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, approximateBytes });
    this.approximateBytes += approximateBytes;
    this.evictOverflow();
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.approximateBytes -= existing.approximateBytes;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.approximateBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOverflow(): void {
    while (
      this.entries.size > 0 &&
      (this.entries.size > this.options.maxEntries ||
        this.approximateBytes > this.options.maxApproximateBytes)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }
}
