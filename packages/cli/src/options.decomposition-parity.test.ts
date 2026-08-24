// cli.md §9 item 1: flag -> settings decomposition parity, using the shared
// SETTINGS_DECOMPOSITION_FIXTURE (settings.md §8 item 7) so a settings field
// routed inconsistently fails here too, not just in packages/settings.
//
// Four settings fields (`enabled`, `validateOnChange`, `validateOnSave`,
// `debounceMs`) are intentionally *not* part of the flag surface (cli.md
// §4.2's table maps them to "—": "accepted in config files, ignored by the
// CLI"). So this test does not assert whole-object equality between "config
// file" and "flags" resolution — it asserts field-by-field parity for every
// field that *does* have a flag mapping, and separately asserts that the
// four host-only fields genuinely have no flag path (flags-only resolution
// falls back to their defaults, while the config-file layer honors the
// fixture's non-default values) — proving the "—" mapping is an honest
// documented gap, not an accidental omission.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  resolveSettings,
  SETTINGS_DECOMPOSITION_FIXTURE,
  type VueHtmlBridgeSettingsInput,
} from "@vue-html-bridge/settings";
import { applyValidatorFlagOps, parseArgv } from "./options.js";

const FIXTURE_RESOLVED = SETTINGS_DECOMPOSITION_FIXTURE.resolved;

const FLAG_MAPPABLE_FIELDS = [
  "include",
  "exclude",
  "maxConcurrency",
  "warnVariantCount",
  "customElements",
  "externalAdapters",
  "validators",
] as const;

const HOST_ONLY_NO_FLAG_FIELDS = [
  "enabled",
  "validateOnChange",
  "validateOnSave",
  "debounceMs",
] as const;

describe("flag -> settings decomposition parity (cli.md §9 item 1)", () => {
  it("the fixture's resolved settings round-trip through resolveSettings as a config-file layer", () => {
    const { settings, issues } = resolveSettings([FIXTURE_RESOLVED]);
    expect(issues).toEqual([]);
    expect(settings).toEqual(FIXTURE_RESOLVED);
  });

  it("an equivalent flag layer produces the same resolved value for every flag-mappable field", () => {
    // Deliberately omits --warn-variant-count: the fixture's warnVariantCount
    // is `undefined` (delegated), which is exactly what *not* passing the
    // flag produces — this also exercises that the delegated field stays
    // omitted rather than being copied as a literal `undefined`.
    const argv = [
      "--include",
      "src/**/*.vue",
      "--exclude",
      "**/node_modules/**",
      "--exclude",
      "**/dist/**",
      "--max-concurrency",
      "3",
      "--custom-elements",
      "my-widget",
      "--external-adapters",
      "trusted-workspace-only",
      "--validator",
      "markuplint",
      "--disable-validator",
      "@acme/vue-html-bridge-adapter-vnu",
      "--validator-setting",
      "@acme/vue-html-bridge-adapter-vnu.strict=true",
    ];
    const parsed = parseArgv(argv);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;

    const { settings: baseResolved, issues } = resolveSettings([
      {},
      parsed.options.settingsInput,
    ]);
    expect(issues).toEqual([]);
    const validators = applyValidatorFlagOps(
      baseResolved.validators,
      parsed.options.validatorOps,
    );
    const flagsResolved = { ...baseResolved, validators };

    for (const field of FLAG_MAPPABLE_FIELDS) {
      expect(flagsResolved[field], field).toEqual(FIXTURE_RESOLVED[field]);
    }
  });

  it("the four host-only fields have no flag path: flags fall back to package defaults", () => {
    const parsed = parseArgv([]);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    const { settings: flagsResolved } = resolveSettings([
      {},
      parsed.options.settingsInput as VueHtmlBridgeSettingsInput,
    ]);

    for (const field of HOST_ONLY_NO_FLAG_FIELDS) {
      expect(flagsResolved[field]).toEqual(DEFAULT_SETTINGS[field]);
    }
    // The fixture varies at least one of these four fields from its
    // default (settings.md's own fixture design) — proving there is
    // something real for the config-file path to differ from, so the "no
    // flag path" assertion above isn't vacuously true.
    expect(
      HOST_ONLY_NO_FLAG_FIELDS.some(
        (field) => FIXTURE_RESOLVED[field] !== DEFAULT_SETTINGS[field],
      ),
    ).toBe(true);
  });
});
