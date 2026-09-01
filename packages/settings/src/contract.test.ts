/**
 * Contract tests (settings.md §8 item 8): the structural types this package
 * declares for other packages' options — `decompose.ts`'s `GenerateOptions`
 * for core, `AnalyzerOptions` for the analyzer — must keep matching the
 * real shapes, even though this package has zero internal runtime
 * dependencies (settings.md §2) and never imports them at runtime.
 *
 * For core's `GenerateOptions`, we check against the *real* type via a
 * type-only import from `vue-html-bridge` (a devDependency-only edge — see
 * `scripts/check-dependency-graph.mjs`'s `EXPECTED_INTERNAL_DEPS`, and
 * compare with how `packages/adapter-markuplint` takes a dev-only edge on
 * `@vue-html-bridge/adapter-testkit`). `import type` is erased entirely at
 * build time (verbatimModuleSyntax), so this adds no runtime dependency —
 * only a devDependency-time typecheck one.
 *
 * Each check below is a *round trip*: assigning a `SettingsGenerateOptions`
 * sample to a `CoreGenerateOptions`-typed variable checks one assignability
 * direction, and assigning that back to a `SettingsGenerateOptions`-typed
 * variable checks the other. If the two interfaces' field sets or field
 * types ever diverge, one of those assignments fails to typecheck
 * (`pnpm run typecheck`) — the values themselves are only there so the
 * checked variables are genuinely used, and so the round trip also has a
 * real runtime assertion (`toEqual`) attached to it.
 */
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_NAME_PATTERN as CORE_ATTRIBUTE_NAME_PATTERN,
  RESERVED_DIRECTIVE_NAMES as CORE_RESERVED_DIRECTIVE_NAMES,
  VALUE_PATH_PATTERN as CORE_VALUE_PATH_PATTERN,
  type GenerateOptions as CoreGenerateOptions,
} from "vue-html-bridge";
import type {
  AnalyzerOptions,
  GenerateOptions as SettingsGenerateOptions,
} from "./decompose.js";
import {
  ATTRIBUTE_NAME_PATTERN as SETTINGS_ATTRIBUTE_NAME_PATTERN,
  RESERVED_DIRECTIVE_NAMES as SETTINGS_RESERVED_DIRECTIVE_NAMES,
  VALUE_PATH_PATTERN as SETTINGS_VALUE_PATH_PATTERN,
} from "./resolve.js";

/** Forces an object literal to have exactly `keyof T`'s keys: TS excess-property checking rejects an extra key, and a missing key fails to satisfy the mapped type. */
type KeysRecord<T> = { [K in keyof T]-?: true };

describe("contract: core GenerateOptions (settings.md §2, §8 item 8)", () => {
  it("is mutually assignable with core's real GenerateOptions", () => {
    const settingsSample: SettingsGenerateOptions = {
      warnVariantCount: 42,
      customElements: ["my-widget"],
      customDirectives: [{ name: "src", attributes: { src: "$value" } }],
    };
    const coreSample: CoreGenerateOptions = settingsSample; // SettingsGenerateOptions -> CoreGenerateOptions
    const roundTrip: SettingsGenerateOptions = coreSample; // CoreGenerateOptions -> SettingsGenerateOptions
    expect(roundTrip).toEqual(settingsSample);
  });

  it("declares exactly the same field names as core's GenerateOptions", () => {
    const coreKeys: KeysRecord<CoreGenerateOptions> = {
      warnVariantCount: true,
      customElements: true,
      customDirectives: true,
    };
    const settingsKeys: KeysRecord<SettingsGenerateOptions> = {
      warnVariantCount: true,
      customElements: true,
      customDirectives: true,
    };
    expect(Object.keys(settingsKeys).sort()).toEqual(
      Object.keys(coreKeys).sort(),
    );
  });
});

/**
 * plan.md §2 / ADR-0010: settings intentionally duplicates core's
 * `ATTRIBUTE_NAME_PATTERN`, `VALUE_PATH_PATTERN`, and
 * `RESERVED_DIRECTIVE_NAMES` (this package has zero internal runtime
 * dependencies, so it cannot import core's copies at runtime) — pinned here
 * so the two copies can never drift apart silently.
 */
describe("contract: custom-directive validation constants (plan.md §2, ADR-0010)", () => {
  it("ATTRIBUTE_NAME_PATTERN sources match", () => {
    expect(SETTINGS_ATTRIBUTE_NAME_PATTERN.source).toBe(
      CORE_ATTRIBUTE_NAME_PATTERN.source,
    );
  });

  it("VALUE_PATH_PATTERN sources match", () => {
    expect(SETTINGS_VALUE_PATH_PATTERN.source).toBe(
      CORE_VALUE_PATH_PATTERN.source,
    );
  });

  it("RESERVED_DIRECTIVE_NAMES sets match", () => {
    expect([...SETTINGS_RESERVED_DIRECTIVE_NAMES].sort()).toEqual(
      [...CORE_RESERVED_DIRECTIVE_NAMES].sort(),
    );
  });
});

/**
 * analyzer.md §2's `CreateWorkspaceAnalyzerOptions.maxConcurrency` and
 * `ReconfigureOptions.maxConcurrency` are both `maxConcurrency?: number` —
 * the same shape `DecomposedSettings.analyzer` decomposes into. Kept
 * purely structural, without a devDependency on `@vue-html-bridge/analyzer`
 * itself: the shape is a single optional primitive field, and analyzer's
 * own dependency chain (core, adapter-testkit, validator-api) would add
 * disproportionate dev-only graph weight for a check this simple. If
 * analyzer's options ever grow beyond `maxConcurrency`, add a real
 * devDependency edge here, matching the core check above.
 */
interface AnalyzerOptionsPerAnalyzerMd {
  maxConcurrency?: number;
}

describe("contract: analyzer options shape (settings.md §2, §8 item 8)", () => {
  it("DecomposedSettings.analyzer is mutually assignable with analyzer.md's maxConcurrency-only shape", () => {
    const docSample: AnalyzerOptionsPerAnalyzerMd = { maxConcurrency: 4 };
    const decomposedSample: AnalyzerOptions = docSample; // doc shape -> AnalyzerOptions
    const roundTrip: AnalyzerOptionsPerAnalyzerMd = decomposedSample; // AnalyzerOptions -> doc shape
    expect(roundTrip).toEqual(docSample);
  });

  it("declares exactly `maxConcurrency`", () => {
    const sample: AnalyzerOptions = { maxConcurrency: 4 };
    expect(Object.keys(sample)).toEqual(["maxConcurrency"]);
  });
});
