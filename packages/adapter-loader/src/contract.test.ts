/**
 * Contract test (adapter-loader.md §2, §6 item 7): `ResolvedValidatorSetting`
 * is declared structurally in this package (§2 — no runtime dependency on
 * `@vue-html-bridge/settings`) and pinned here to the real
 * `@vue-html-bridge/settings` shape via a type-only import — a
 * devDependency-only edge (see scripts/check-dependency-graph.mjs's
 * EXPECTED_INTERNAL_DEPS), the same pattern `@vue-html-bridge/settings`
 * itself uses for core's `GenerateOptions`, and
 * `@vue-html-bridge/adapter-markuplint` uses for
 * `@vue-html-bridge/adapter-testkit`. `import type` is erased entirely at
 * build time (verbatimModuleSyntax), so this adds no runtime dependency —
 * only a devDependency-time typecheck one.
 *
 * Each check below is a round trip: assigning a loader sample to a
 * settings-typed variable checks one assignability direction; assigning
 * that back to a loader-typed variable checks the other. If the two
 * interfaces' field sets or field types ever diverge, one of those
 * assignments fails to typecheck (`pnpm run typecheck`).
 */
import { describe, expect, it } from "vitest";
import type { ResolvedValidatorSetting as SettingsResolvedValidatorSetting } from "@vue-html-bridge/settings";
import type { ResolvedValidatorSetting as LoaderResolvedValidatorSetting } from "./types.js";

/** Forces an object literal to have exactly `keyof T`'s keys. */
type KeysRecord<T> = { [K in keyof T]-?: true };

describe("contract: ResolvedValidatorSetting (adapter-loader.md §2, §6 item 7)", () => {
  it("is mutually assignable with settings' real ResolvedValidatorSetting", () => {
    const loaderSample: LoaderResolvedValidatorSetting = {
      adapter: "markuplint",
      enabled: true,
      settings: { rule: true },
    };
    const settingsSample: SettingsResolvedValidatorSetting = loaderSample; // loader -> settings
    const roundTrip: LoaderResolvedValidatorSetting = settingsSample; // settings -> loader
    expect(roundTrip).toEqual(loaderSample);
  });

  it("declares exactly the same field names as settings' ResolvedValidatorSetting", () => {
    const settingsKeys: KeysRecord<SettingsResolvedValidatorSetting> = {
      adapter: true,
      enabled: true,
      settings: true,
    };
    const loaderKeys: KeysRecord<LoaderResolvedValidatorSetting> = {
      adapter: true,
      enabled: true,
      settings: true,
    };
    expect(Object.keys(loaderKeys).sort()).toEqual(
      Object.keys(settingsKeys).sort(),
    );
  });
});
