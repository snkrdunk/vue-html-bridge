// Bounded-concurrency work runner (analyzer.md §5.3):
// - maxConcurrency bounds the whole queue.
// - Each adapter's own maxConcurrentValidations is also enforced.
// - No new work starts once the signal is aborted.
// - A rejection from one item is isolated and does not cancel the others.
// - Once the (single, request-wide) signal is aborted, every task's outcome
//   is discarded, not just non-cancellable adapters' — a cancellable
//   adapter's own validate() call is expected to reject *because of* the
//   same abort (monorepo.md §11: cancellation is never a diagnostic), so
//   treating that rejection as a real execution-error would be wrong. What
//   `supportsCancellation` actually changes is that a non-cancellable
//   adapter's call may keep running and complete normally well after the
//   signal fires — Promise.all still has to wait it out (a real in-flight
//   call can't be un-awaited), but its result is just as discarded.

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
            if (signal.aborted) return undefined;
            return { item: task.item, adapterId: task.adapterId, result };
          } catch (error) {
            if (signal.aborted) return undefined;
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
