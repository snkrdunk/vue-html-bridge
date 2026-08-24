/**
 * A shared contract fixture (adapter-loader.md §6 item 8): the language
 * server and the CLI are each expected to run these scenarios against
 * their own real `loadConfiguredAdapters` wiring — using
 * `ADAPTER_LOADER_CONTRACT_BUILTINS` and
 * `adapterLoaderContractModuleResolver` in place of the injected pieces
 * this package cannot itself own (a host's bundled built-in and its real
 * module resolver) — asserting the same `adapters` / `failures` shape for
 * each one, so the two hosts cannot silently drift on adapter-loading
 * behavior. No real npm packages are involved: every specifier below is
 * "magic", recognized only by `adapterLoaderContractModuleResolver`.
 *
 * This package itself replays the fixture against `loadConfiguredAdapters`
 * directly (`contract-fixture.test.ts`) to prove the expectations are
 * accurate; wiring it into either host is separate, later work.
 */
import {
  VALIDATOR_API_VERSION,
  type HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";
import { AdapterModuleResolutionError } from "./resolver.js";
import type {
  AdapterLoadFailureKind,
  AdapterModuleResolver,
  LoadAdaptersTrust,
  ResolvedValidatorSetting,
} from "./types.js";

export const CONTRACT_FIXTURE_BUILTIN_ID = "contract-fixture-builtin";
export const CONTRACT_FIXTURE_BUILTIN_BAD_VERSION_ID =
  "contract-fixture-builtin-bad-version";
export const CONTRACT_FIXTURE_VALID_EXTERNAL =
  "contract-fixture-external-valid";
export const CONTRACT_FIXTURE_UNRESOLVABLE_EXTERNAL =
  "contract-fixture-external-unresolvable";
export const CONTRACT_FIXTURE_THROWING_EXTERNAL =
  "contract-fixture-external-throwing";
export const CONTRACT_FIXTURE_INVALID_SHAPE_EXTERNAL =
  "contract-fixture-external-invalid-shape";
export const CONTRACT_FIXTURE_API_VERSION_MISMATCH_EXTERNAL =
  "contract-fixture-external-api-version-mismatch";
export const CONTRACT_FIXTURE_DUPLICATE_EXTERNAL =
  "contract-fixture-external-duplicate";

const TRUSTED: LoadAdaptersTrust = {
  workspaceTrusted: true,
  externalAdapters: "trusted-workspace-only",
};

function fixtureAdapter(id: string): HtmlValidatorAdapter<unknown> {
  return {
    apiVersion: VALIDATOR_API_VERSION,
    id,
    displayName: id,
    capabilities: {
      execution: "in-process",
      supportsCancellation: false,
      supportsConfigFiles: false,
      fragmentHandling: "native",
      maxConcurrentValidations: 1,
    },
    async createSession() {
      return {
        async validate() {
          return { diagnostics: [], failures: [] };
        },
        async dispose() {},
      };
    },
  };
}

/**
 * Built-ins a host would pass through `LoadAdaptersRequest.builtins` to
 * exercise the fixture's built-in scenarios.
 */
export const ADAPTER_LOADER_CONTRACT_BUILTINS = new Map<
  string,
  HtmlValidatorAdapter<unknown>
>([
  [CONTRACT_FIXTURE_BUILTIN_ID, fixtureAdapter(CONTRACT_FIXTURE_BUILTIN_ID)],
  [
    CONTRACT_FIXTURE_BUILTIN_BAD_VERSION_ID,
    {
      ...fixtureAdapter(CONTRACT_FIXTURE_BUILTIN_BAD_VERSION_ID),
      apiVersion: 999,
    } as unknown as HtmlValidatorAdapter<unknown>,
  ],
]);

/**
 * A `moduleResolver` a host would pass through
 * `LoadAdaptersRequest.moduleResolver` to exercise the fixture's external
 * scenarios, in place of its real (Node/PnP) resolver.
 */
export const adapterLoaderContractModuleResolver: AdapterModuleResolver =
  async (specifier) => {
    switch (specifier) {
      case CONTRACT_FIXTURE_VALID_EXTERNAL:
        return { default: fixtureAdapter(CONTRACT_FIXTURE_VALID_EXTERNAL) };
      case CONTRACT_FIXTURE_DUPLICATE_EXTERNAL:
        // Deliberately collides with the builtin's runtime id, even though
        // its specifier/entryKey differs (§4 item 4).
        return { default: fixtureAdapter(CONTRACT_FIXTURE_BUILTIN_ID) };
      case CONTRACT_FIXTURE_THROWING_EXTERNAL:
        throw new Error("contract fixture: import threw");
      case CONTRACT_FIXTURE_INVALID_SHAPE_EXTERNAL:
        // A correct apiVersion but missing displayName/capabilities/
        // createSession, so this is rejected for its shape, not its
        // apiVersion (checkHtmlValidatorAdapter checks apiVersion first).
        return {
          default: {
            apiVersion: VALIDATOR_API_VERSION,
            id: CONTRACT_FIXTURE_INVALID_SHAPE_EXTERNAL,
            not: "an adapter",
          },
        };
      case CONTRACT_FIXTURE_API_VERSION_MISMATCH_EXTERNAL:
        return {
          default: {
            ...fixtureAdapter(specifier),
            apiVersion: 999,
          },
        };
      default:
        throw new AdapterModuleResolutionError(
          `contract fixture: no module registered for "${specifier}"`,
        );
    }
  };

export interface AdapterLoaderContractScenario {
  name: string;
  trust: LoadAdaptersTrust;
  validators: readonly ResolvedValidatorSetting[];
  /** Expected `adapters[]`, in order. */
  expectedAdapters: readonly { entryKey: string; enabled: boolean }[];
  /** Expected `failures[]` (specifier, kind) pairs, in order, after dedupe. */
  expectedFailures: readonly {
    specifier: string;
    kind: AdapterLoadFailureKind;
  }[];
}

export const ADAPTER_LOADER_CONTRACT_SCENARIOS: readonly AdapterLoaderContractScenario[] =
  [
    {
      name: "a built-in adapter loads regardless of trust",
      trust: { workspaceTrusted: false, externalAdapters: "disabled" },
      validators: [{ adapter: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true }],
      expectedAdapters: [
        { entryKey: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
      ],
      expectedFailures: [],
    },
    {
      name: "a built-in adapter with a mismatched apiVersion fails",
      trust: TRUSTED,
      validators: [
        { adapter: CONTRACT_FIXTURE_BUILTIN_BAD_VERSION_ID, enabled: true },
      ],
      expectedAdapters: [],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_BUILTIN_BAD_VERSION_ID,
          kind: "api-version-mismatch",
        },
      ],
    },
    {
      name: "an external adapter is blocked when externalAdapters is disabled",
      trust: { workspaceTrusted: true, externalAdapters: "disabled" },
      validators: [{ adapter: CONTRACT_FIXTURE_VALID_EXTERNAL, enabled: true }],
      expectedAdapters: [],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_VALID_EXTERNAL,
          kind: "external-adapters-disabled",
        },
      ],
    },
    {
      name: "an external adapter is blocked when the workspace is not trusted",
      trust: {
        workspaceTrusted: false,
        externalAdapters: "trusted-workspace-only",
      },
      validators: [{ adapter: CONTRACT_FIXTURE_VALID_EXTERNAL, enabled: true }],
      expectedAdapters: [],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_VALID_EXTERNAL,
          kind: "workspace-not-trusted",
        },
      ],
    },
    {
      name: "a path-shaped specifier is rejected without a resolution attempt",
      trust: TRUSTED,
      validators: [{ adapter: "./local-adapter", enabled: true }],
      expectedAdapters: [],
      expectedFailures: [
        { specifier: "./local-adapter", kind: "invalid-specifier" },
      ],
    },
    {
      name: "an unresolvable external adapter fails in isolation",
      trust: TRUSTED,
      validators: [
        { adapter: CONTRACT_FIXTURE_UNRESOLVABLE_EXTERNAL, enabled: true },
        { adapter: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
      ],
      expectedAdapters: [
        { entryKey: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
      ],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_UNRESOLVABLE_EXTERNAL,
          kind: "resolution-failed",
        },
      ],
    },
    {
      name: "an external adapter whose import throws fails in isolation",
      trust: TRUSTED,
      validators: [
        { adapter: CONTRACT_FIXTURE_THROWING_EXTERNAL, enabled: true },
        { adapter: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
      ],
      expectedAdapters: [
        { entryKey: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
      ],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_THROWING_EXTERNAL,
          kind: "import-threw",
        },
      ],
    },
    {
      name: "an external adapter with an invalid runtime shape fails",
      trust: TRUSTED,
      validators: [
        { adapter: CONTRACT_FIXTURE_INVALID_SHAPE_EXTERNAL, enabled: true },
      ],
      expectedAdapters: [],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_INVALID_SHAPE_EXTERNAL,
          kind: "invalid-shape",
        },
      ],
    },
    {
      name: "an external adapter with a mismatched apiVersion fails",
      trust: TRUSTED,
      validators: [
        {
          adapter: CONTRACT_FIXTURE_API_VERSION_MISMATCH_EXTERNAL,
          enabled: true,
        },
      ],
      expectedAdapters: [],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_API_VERSION_MISMATCH_EXTERNAL,
          kind: "api-version-mismatch",
        },
      ],
    },
    {
      name: "a trusted external adapter loads once every gate passes",
      trust: TRUSTED,
      validators: [{ adapter: CONTRACT_FIXTURE_VALID_EXTERNAL, enabled: true }],
      expectedAdapters: [
        { entryKey: CONTRACT_FIXTURE_VALID_EXTERNAL, enabled: true },
      ],
      expectedFailures: [],
    },
    {
      name: "a disabled external adapter is never imported",
      trust: TRUSTED,
      validators: [
        { adapter: CONTRACT_FIXTURE_VALID_EXTERNAL, enabled: false },
      ],
      expectedAdapters: [
        { entryKey: CONTRACT_FIXTURE_VALID_EXTERNAL, enabled: false },
      ],
      expectedFailures: [],
    },
    {
      name: "a duplicate runtime id fails the later entry and keeps the first",
      trust: TRUSTED,
      validators: [
        { adapter: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
        { adapter: CONTRACT_FIXTURE_DUPLICATE_EXTERNAL, enabled: true },
      ],
      expectedAdapters: [
        { entryKey: CONTRACT_FIXTURE_BUILTIN_ID, enabled: true },
      ],
      expectedFailures: [
        {
          specifier: CONTRACT_FIXTURE_DUPLICATE_EXTERNAL,
          kind: "duplicate-runtime-id",
        },
      ],
    },
  ];
