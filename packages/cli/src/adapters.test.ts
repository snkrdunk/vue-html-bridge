// cli.md §9 item 13: external adapter loading — the shared loader's gates
// apply identically to the language server's, contract-tested against
// adapter-loader.md, exactly the way
// packages/language-server/src/adapters/loading.test.ts does.
import { describe, expect, it } from "vitest";
import {
  ADAPTER_LOADER_CONTRACT_BUILTINS,
  ADAPTER_LOADER_CONTRACT_SCENARIOS,
  adapterLoaderContractModuleResolver,
} from "@vue-html-bridge/adapter-loader";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import { builtinMarkuplintSettings, loadAdaptersForRun } from "./adapters.js";

describe("loadAdaptersForRun: shared adapter-loader contract fixture (adapter-loader.md §6 item 8, cli.md §9 item 13)", () => {
  for (const scenario of ADAPTER_LOADER_CONTRACT_SCENARIOS) {
    it(scenario.name, async () => {
      const result = await loadAdaptersForRun({
        validators: scenario.validators,
        workspaceRoot: "/workspace",
        workspaceTrusted: scenario.trust.workspaceTrusted,
        externalAdapters: scenario.trust.externalAdapters,
        moduleResolver: adapterLoaderContractModuleResolver,
        builtins: ADAPTER_LOADER_CONTRACT_BUILTINS,
      });
      expect(
        result.adapters.map((adapter) => ({
          entryKey: adapter.adapter.id,
          enabled: adapter.enabled,
        })),
      ).toEqual(scenario.expectedAdapters);
      expect(
        result.failures.map((failure) => ({
          specifier: failure.specifier,
          kind: failure.kind,
        })),
      ).toEqual(scenario.expectedFailures);
    });
  }
});

describe("loadAdaptersForRun: built-in Markuplint trust restriction (cli.md §5)", () => {
  it("applies the untrusted-run restriction to the loaded built-in", async () => {
    const result = await loadAdaptersForRun({
      validators: [
        {
          adapter: "markuplint",
          enabled: true,
          settings: { configFile: "/workspace/.markuplintrc" },
        },
      ],
      workspaceRoot: "/workspace",
      workspaceTrusted: false,
      externalAdapters: "disabled",
    });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]!.adapter).toBe(markuplintAdapter);
    expect(result.adapters[0]!.settings).toEqual({ searchConfig: false });
    expect(result.failures).toEqual([]);
  });

  it("uses the entry's own settings unchanged in a trusted run", async () => {
    const result = await loadAdaptersForRun({
      validators: [
        {
          adapter: "markuplint",
          enabled: true,
          settings: { configFile: "/workspace/.markuplintrc" },
        },
      ],
      workspaceRoot: "/workspace",
      workspaceTrusted: true,
      externalAdapters: "disabled",
    });
    expect(result.adapters[0]!.settings).toEqual({
      configFile: "/workspace/.markuplintrc",
    });
  });

  it("builtinMarkuplintSettings directly: false trust forces bundled defaults regardless of the entry", () => {
    expect(
      builtinMarkuplintSettings(
        { adapter: "markuplint", enabled: true, settings: { a: 1 } },
        false,
      ),
    ).toEqual({ searchConfig: false });
    expect(
      builtinMarkuplintSettings(
        { adapter: "markuplint", enabled: true, settings: { a: 1 } },
        true,
      ),
    ).toEqual({ a: 1 });
    expect(builtinMarkuplintSettings(undefined, true)).toEqual({});
  });
});
