import {
  VALIDATOR_API_VERSION,
  type ConfigWatchTarget,
  type HtmlValidatorAdapter,
  type ValidateHtmlRequest,
  type ValidateHtmlResult,
} from "@vue-html-bridge/validator-api";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export interface FakeAdapterSettings {
  readonly label?: string;
}

export interface FakeValidateCall {
  request: ValidateHtmlRequest;
  settings: FakeAdapterSettings;
}

export interface FakeAdapterOptions {
  id?: string;
  displayName?: string;
  maxConcurrentValidations?: number;
  supportsCancellation?: boolean;
  handler?: (
    request: ValidateHtmlRequest,
    signal: AbortSignal,
  ) => Promise<ValidateHtmlResult> | ValidateHtmlResult;
}

export interface FakeAdapterController {
  adapter: HtmlValidatorAdapter<FakeAdapterSettings>;
  readonly calls: readonly FakeValidateCall[];
  readonly activeCalls: number;
  readonly maximumActiveCalls: number;
  readonly disposeCount: number;
  enqueue(result: ValidateHtmlResult | Error): void;
  blockNext(): Deferred<void>;
  setConfigWatchTargets(targets: readonly ConfigWatchTarget[]): void;
}

export function createFakeAdapter(
  options: FakeAdapterOptions = {},
): FakeAdapterController {
  const calls: FakeValidateCall[] = [];
  const queue: (ValidateHtmlResult | Error)[] = [];
  const barriers: Deferred<void>[] = [];
  let watchTargets: readonly ConfigWatchTarget[] = [];
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  let disposeCount = 0;

  const controller: FakeAdapterController = {
    adapter: {
      apiVersion: VALIDATOR_API_VERSION,
      id: options.id ?? "fake",
      displayName: options.displayName ?? "Fake adapter",
      capabilities: {
        execution: "in-process",
        supportsCancellation: options.supportsCancellation ?? true,
        supportsConfigFiles: true,
        fragmentHandling: "native",
        maxConcurrentValidations: options.maxConcurrentValidations ?? 4,
        configFilePatterns: ["**/.fake-validator.json"],
      },
      async createSession({ settings }) {
        let disposed = false;
        return {
          async validate(request, signal) {
            signal.throwIfAborted();
            if (disposed) throw new Error("Fake adapter session is disposed.");
            calls.push({ request: structuredClone(request), settings });
            activeCalls += 1;
            maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
            try {
              const barrier = barriers.shift();
              if (barrier) await abortable(barrier.promise, signal);
              signal.throwIfAborted();
              if (options.handler)
                return await options.handler(request, signal);
              const next = queue.shift() ?? { diagnostics: [], failures: [] };
              if (next instanceof Error) throw next;
              return structuredClone(next);
            } finally {
              activeCalls -= 1;
            }
          },
          getConfigWatchTargets() {
            return watchTargets;
          },
          async dispose() {
            if (!disposed) {
              disposed = true;
              disposeCount += 1;
            }
          },
        };
      },
    },
    get calls() {
      return calls;
    },
    get activeCalls() {
      return activeCalls;
    },
    get maximumActiveCalls() {
      return maximumActiveCalls;
    },
    get disposeCount() {
      return disposeCount;
    },
    enqueue(result) {
      queue.push(result);
    },
    blockNext() {
      const deferred = createDeferred<void>();
      barriers.push(deferred);
      return deferred;
    },
    setConfigWatchTargets(targets) {
      watchTargets = structuredClone(targets);
    },
  };
  return controller;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
