// Bounded-concurrency work runner (analyzer.md §5.3):
// - maxConcurrency bounds the whole queue.
// - Each adapter's own maxConcurrentValidations is also enforced.
// - No new work starts once the signal is aborted.
// - A rejection from one item is isolated and does not cancel the others.
// - A result from a non-cancellable adapter that finishes after abort is discarded.

class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface BoundedTask<TItem, TResult> {
  item: TItem;
  adapterId: string;
  supportsCancellation: boolean;
  run(signal: AbortSignal): Promise<TResult>;
}

export interface BoundedOutcome<TItem, TResult> {
  item: TItem;
  adapterId: string;
  result?: TResult;
  error?: unknown;
}

export async function runBounded<TItem, TResult>(
  tasks: readonly BoundedTask<TItem, TResult>[],
  maxConcurrency: number,
  perAdapterLimits: ReadonlyMap<string, number>,
  signal: AbortSignal,
): Promise<readonly BoundedOutcome<TItem, TResult>[]> {
  const globalSemaphore = new Semaphore(maxConcurrency);
  const adapterSemaphores = new Map<string, Semaphore>();
  const semaphoreFor = (adapterId: string): Semaphore => {
    let semaphore = adapterSemaphores.get(adapterId);
    if (!semaphore) {
      semaphore = new Semaphore(perAdapterLimits.get(adapterId) ?? 1);
      adapterSemaphores.set(adapterId, semaphore);
    }
    return semaphore;
  };

  const outcomes = await Promise.all(
    tasks.map(
      async (task): Promise<BoundedOutcome<TItem, TResult> | undefined> => {
        if (signal.aborted) return undefined;
        const releaseGlobal = await globalSemaphore.acquire();
        try {
          if (signal.aborted) return undefined;
          const releaseAdapter = await semaphoreFor(task.adapterId).acquire();
          try {
            if (signal.aborted) return undefined;
            const result = await task.run(signal);
            if (signal.aborted && !task.supportsCancellation) return undefined;
            return { item: task.item, adapterId: task.adapterId, result };
          } catch (error) {
            if (signal.aborted && !task.supportsCancellation) return undefined;
            return { item: task.item, adapterId: task.adapterId, error };
          } finally {
            releaseAdapter();
          }
        } finally {
          releaseGlobal();
        }
      },
    ),
  );
  return outcomes.filter(
    (outcome): outcome is BoundedOutcome<TItem, TResult> =>
      outcome !== undefined,
  );
}
