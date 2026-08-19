# `@vue-html-bridge/adapter-testkit` design

Status: Proposed  
Package directory: `packages/adapter-testkit`

## 1. Role

This package is a developer-facing tool that verifies whether an adapter implementing `@vue-html-bridge/validator-api` meets the common contract: ranges, failures, cancellation, session lifecycle, and so on.

We publish this package instead of keeping it as a private test utility for the Markuplint adapter only. It proves — with runtime tests, not just types — that a second or third validator adapter can be added without changing the analyzer or the language server.

### In scope

- The common suite of adapter contract tests
- Adapter fixture factories and expectation helpers
- The fake adapter used in analyzer unit tests
- Assertion utilities for UTF-16 ranges, line indexes, and determinism
- A minimal sample for adapter authors

### Out of scope

- Adapter loading in the production runtime
- Installing real validators
- Generating SFC variants
- The LSP E2E harness

This package is a `devDependency` only. It is not included in the language server's production bundle.

## 2. Public API

To avoid over-depending on any one test framework, we separate the core API that returns contract cases from the Vitest binding.

```ts
export interface AdapterContractFixture<TSettings> {
  adapter: HtmlValidatorAdapter<TSettings>;
  workspaceRoot: string;
  settings: TSettings;

  validHtml: string;
  invalidHtml: {
    html: string;
    expectedRuleId?: string;
    expectedSubstring: string;
    expectedSeverity?: DiagnosticSeverity;
  };

  createFailureSettings?: () => TSettings;
}

export function createAdapterContractCases<TSettings>(
  fixture: AdapterContractFixture<TSettings>,
): readonly AdapterContractCase[];

export function defineVitestAdapterContract<TSettings>(
  name: string,
  fixture: AdapterContractFixture<TSettings>,
): void;
```

Users of other test runners can call `createAdapterContractCases` directly, without Vitest.

## 3. Contract cases

### 3.1 Valid/invalid HTML

```ts
it("returns no diagnostics for valid HTML", async () => {
  const result = await session.validate(request("<button>OK</button>"), signal);
  expect(result.diagnostics).toEqual([]);
  expect(result.failures).toEqual([]);
});

it("points to the invalid generated token", async () => {
  const html = '<button aria-pressed="sometimes">Toggle</button>';
  const result = await session.validate(request(html), signal);
  const diagnostic = findExpectedDiagnostic(result, "sometimes");

  expect(html.slice(diagnostic.range!.start, diagnostic.range!.end)).toContain(
    "sometimes",
  );
});
```

Each real validator has a different rule set, so the testkit does not force the same invalid HTML on every adapter. Instead, the fixture supplies an invalid case that the validator is guaranteed to flag, along with the expected substring.

### 3.2 UTF-16 and multiple lines

An emoji takes 2 UTF-16 code units. This lets us detect implementations that incorrectly use `Array.from(text).length` or a code-point-based column.

```ts
it("reports UTF-16 offsets after an astral character", async () => {
  const html = [
    '<div aria-label="😀">',
    '  <button aria-pressed="sometimes">Toggle</button>',
    "</div>",
  ].join("\n");

  const result = await session.validate(request(html), signal);
  const diagnostic = findExpectedDiagnostic(result, "sometimes");
  const expectedStart = html.indexOf("sometimes");

  expect(diagnostic.range?.start).toBe(expectedStart);
  expect(html.slice(diagnostic.range!.start, diagnostic.range!.end)).toContain(
    "sometimes",
  );
});
```

We use parameterized fixtures for LF, CRLF, a leading emoji, a combining mark, attribute values, and element names/end tags.

### 3.3 No range

If the adapter can inject a fixture for which the validator returns no position, we confirm that the adapter returns `undefined` instead of inventing a `range`. If this cannot be reproduced with a real validator, we unit-test the adapter's raw-result converter directly.

### 3.4 Severity and order

- Validator-specific severities map to the common severity values.
- Known rules that depend on source representation or document context get an `applicability` classification; unknown rules can default to `html-semantics`.
- Multiple diagnostics follow the contracted order: range, rule, message.
- Validating the same request twice produces deep-equal results.
- Aside from `metadata`, results must not contain timestamps, random IDs, or temp paths.

### 3.5 Failure

```ts
it("returns configuration failures separately", async () => {
  const failing = await fixture.adapter.createSession({
    workspaceRoot,
    settings: fixture.createFailureSettings!(),
    logger,
  });

  const result = await failing.validate(request("<div></div>"), signal);

  expect(result.diagnostics).toEqual([]);
  expect(result.failures[0]?.code).toBe("configuration-error");
});
```

The key point: an HTML violation and a config/execution failure must never end up in the same `diagnostics` array.

For adapters where an environmental failure can occur during `createSession`, we confirm that the rejection has the runtime shape of `AdapterSessionFailure` (validator-api §3.1). A configuration failure must be reported either as an `AdapterSessionFailure` from `createSession`, or in `failures[]` from `validate` — never in `diagnostics`.

### 3.6 Cancellation

Using a fake clock/barrier, we distinguish between:

- Already aborted before validate: the validator is not called; result is AbortError.
- Aborted during validate, with native cancel support: prompt AbortError.
- No native cancel support: capability is false, and AbortError arrives only after completion.
- Abort must not be converted into an `execution-error` failure.

We avoid relying on a time-based `sleep(100)`. Instead we use an adapter test hook or a controllable promise.

### 3.7 Session lifecycle

- `createSession` receives the workspace root, settings, and logger.
- Whether multiple `validate` calls can run sequentially or concurrently matches what the capability/adapter documentation states.
- Calling `dispose` twice does not raise a resource-release error.
- A `validate` call after dispose fails clearly.
- State from one config/session does not leak into another session.

### 3.8 Concurrent execution, wrapped mode, and input immutability

- Running `validate` concurrently, within the `maxConcurrentValidations` limit from the capabilities, produces results that are deep-equal to running them sequentially. The testkit itself never issues more concurrent calls than that limit.
- An adapter with `fragmentHandling: "wrapped"` must not return diagnostics that originate only from the wrapper, and must correct diagnostic ranges to be relative to `request.html` (`html.slice(start, end)` must point to the matching token inside the fragment).
- `validate` must not modify the `html` string or the `request` object.
- The adapter's public metadata (`apiVersion`, `id`, capabilities) passes the validator-api runtime shape check.

### 3.9 JSON serializability

```ts
expect(() => JSON.stringify(result)).not.toThrow();
expect(JSON.parse(JSON.stringify(result))).toEqual(result);
```

When comparing, we normalize the object first so that dropped `undefined` optional fields do not cause a mismatch. `data` / `metadata` must never contain an `Error` object, a `BigInt`, a circular reference, or a class instance.

## 4. Fake adapter

For analyzer tests, we provide a fake adapter that returns an arbitrary result based on input HTML and a barrier.

```ts
export interface FakeAdapterController {
  adapter: HtmlValidatorAdapter<FakeAdapterSettings>;
  calls: readonly FakeValidateCall[];
  enqueue(result: ValidateHtmlResult | Error): void;
  blockNext(): Deferred<void>;
}

export function createFakeAdapter(
  options?: FakeAdapterOptions,
): FakeAdapterController;
```

Usage:

```ts
const fake = createFakeAdapter();
fake.enqueue({
  diagnostics: [
    {
      ruleId: "invalid-attr",
      severity: "error",
      message: "Invalid value",
      range: { start: 12, end: 17 },
    },
  ],
  failures: [],
});

const analyzer = await createWorkspaceAnalyzer({
  workspaceRoot,
  adapters: [{ adapter: fake.adapter, settings: {}, enabled: true }],
});

await analyzer.analyze(request);
expect(fake.calls).toHaveLength(1);
```

We split package exports into `./fake` and `./vitest` so that the fake is never imported outside of tests.

## 5. Sample adapter

We provide an educational adapter that detects `<blink>` with a regular expression, either as `examples/adapter-minimal` or as a fixture inside the package. We do not publish it as a production validator. In a small amount of code, it demonstrates:

- Adapter metadata
- Session creation/dispose
- UTF-16 ranges
- AbortSignal
- The difference between a failure and a diagnostic
- How to call the contract suite

```ts
defineVitestAdapterContract("no-blink", {
  adapter: noBlinkAdapter,
  workspaceRoot: fixtureRoot,
  settings: {},
  validHtml: "<p>text</p>",
  invalidHtml: {
    html: "<blink>text</blink>",
    expectedRuleId: "no-blink",
    expectedSubstring: "blink",
  },
});
```

## 6. Self-tests

- We prepare intentionally broken adapters and confirm that each contract actually fails on them.
- An adapter with wrong code-point offsets
- An adapter with unstable ordering
- An adapter that converts abort into a failure
- An adapter that puts an Error object into metadata
- An adapter that throws on the second `dispose` call
- A wrapped adapter that does not correct the wrapper range
- An adapter that mutates the request
- An adapter with invalid capabilities (for example, a missing `maxConcurrentValidations`)

We keep these mutation-style negative fixtures so the contract tests themselves do not become a formality.

## 7. Versioning

- The testkit major version matches the corresponding validator-api major version.
- A change that tightens the contract in a way that could fail existing adapters is introduced as a major version bump, or as an opt-in case — not as a minor version.
- Validator-specific fixtures belong to each adapter package; the testkit does not carry them.
- The fake adapter's API counts as a test utility for the analyzer, and is covered by semver.

## 8. Test list

Before publishing, the testkit verifies the following about itself.

1. Framework-neutral contract cases can run without the Vitest binding.
2. Valid/invalid, UTF-16, multiline, no range, severity, ordering.
3. Pre-abort / mid-abort / non-native cancellation.
4. Separation of configuration/execution failures, and the shape of `AdapterSessionFailure`.
5. JSON serializability.
6. Session isolation and idempotent dispose.
7. Concurrent execution within `maxConcurrentValidations` matches sequential execution results.
8. Range correction in wrapped mode, exclusion of wrapper-originated diagnostics, and request immutability.
9. Fake adapter call capture, queue, barrier, and throw behavior.
10. Broken adapters are detected by the matching contract.

## 9. Proposed internal module layout

```text
src/
├── index.ts
├── cases/
│   ├── basics.ts
│   ├── positions.ts
│   ├── cancellation.ts
│   ├── failures.ts
│   └── lifecycle.ts
├── assertions.ts
├── fake.ts
└── vitest.ts
```

Package exports are split into `.`, `./fake`, and `./vitest`, so the framework-neutral entry point never references the Vitest dependency.
