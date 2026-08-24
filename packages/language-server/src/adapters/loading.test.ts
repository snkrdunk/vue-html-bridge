import { describe, expect, it } from "vitest";
import {
  ADAPTER_LOADER_CONTRACT_BUILTINS,
  ADAPTER_LOADER_CONTRACT_SCENARIOS,
  adapterLoaderContractModuleResolver,
} from "@vue-html-bridge/adapter-loader";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import { loadAdaptersForSession } from "./loading.js";

describe("loadAdaptersForSession: shared adapter-loader contract fixture (adapter-loader.md §6 item 8)", () => {
  for (const scenario of ADAPTER_LOADER_CONTRACT_SCENARIOS) {
    it(scenario.name, async () => {
      const result = await loadAdaptersForSession({
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

describe("loadAdaptersForSession: built-in Markuplint trust restriction (language-server.md §4.2)", () => {
  it("applies builtinMarkuplintSettings' untrusted-workspace restriction to the loaded built-in", async () => {
    const result = await loadAdaptersForSession({
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

  it("uses the entry's own settings unchanged in a trusted workspace", async () => {
    const result = await loadAdaptersForSession({
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

  it("excludes the built-in when validators[] doesn't name it (an explicit override replaced the default)", async () => {
    const result = await loadAdaptersForSession({
      validators: [{ adapter: "some-other-adapter", enabled: true }],
      workspaceRoot: "/workspace",
      workspaceTrusted: true,
      externalAdapters: "trusted-workspace-only",
    });
    expect(result.adapters.some((a) => a.adapter.id === "markuplint")).toBe(
      false,
    );
  });
});
