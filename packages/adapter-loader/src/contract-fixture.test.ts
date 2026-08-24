/**
 * Self-consistency check for the shared contract fixture (adapter-loader.md
 * §6 item 8): replays every `ADAPTER_LOADER_CONTRACT_SCENARIOS` entry
 * against the real `loadConfiguredAdapters`, using the fixture's own
 * `ADAPTER_LOADER_CONTRACT_BUILTINS` / `adapterLoaderContractModuleResolver`.
 * This proves the fixture's expectations are accurate before either host
 * adopts it in its own integration tests (separate, later work).
 */
import { describe, expect, it } from "vitest";
import {
  ADAPTER_LOADER_CONTRACT_BUILTINS,
  ADAPTER_LOADER_CONTRACT_SCENARIOS,
  adapterLoaderContractModuleResolver,
} from "./contract-fixture.js";
import { loadConfiguredAdapters } from "./load.js";

describe("ADAPTER_LOADER_CONTRACT_SCENARIOS", () => {
  it.each(ADAPTER_LOADER_CONTRACT_SCENARIOS)("$name", async (scenario) => {
    const result = await loadConfiguredAdapters({
      validators: scenario.validators,
      workspaceRoot: "/workspace",
      trust: scenario.trust,
      builtins: ADAPTER_LOADER_CONTRACT_BUILTINS,
      moduleResolver: adapterLoaderContractModuleResolver,
    });

    expect(
      result.adapters.map((loaded) => ({
        entryKey: loaded.entryKey,
        enabled: loaded.enabled,
      })),
    ).toEqual(scenario.expectedAdapters);
    expect(
      result.failures.map((failure) => ({
        specifier: failure.specifier,
        kind: failure.kind,
      })),
    ).toEqual(scenario.expectedFailures);
  });
});
