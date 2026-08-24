import {
  VALIDATOR_API_VERSION,
  type HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";
import { describe, expect, it, vi } from "vitest";
import { loadConfiguredAdapters } from "./load.js";
import { AdapterModuleResolutionError } from "./resolver.js";
import type {
  AdapterModuleResolver,
  LoadAdaptersTrust,
  ResolvedValidatorSetting,
} from "./types.js";

const WORKSPACE_ROOT = "/workspace";

const TRUSTED: LoadAdaptersTrust = {
  workspaceTrusted: true,
  externalAdapters: "trusted-workspace-only",
};

function stubAdapter(
  id: string,
  overrides: Partial<HtmlValidatorAdapter<unknown>> = {},
): HtmlValidatorAdapter<unknown> {
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
    ...overrides,
  };
}

function entry(
  adapter: string,
  overrides: Partial<ResolvedValidatorSetting> = {},
): ResolvedValidatorSetting {
  return { adapter, enabled: true, ...overrides };
}

function throwingResolver(): AdapterModuleResolver {
  return vi.fn(async () => {
    throw new Error("should not be called");
  });
}

describe("loadConfiguredAdapters: gate matrix (adapter-loader.md §6 item 1)", () => {
  it("fails external-adapters-disabled while other entries still load", async () => {
    const builtins = new Map([["builtin", stubAdapter("builtin")]]);
    const moduleResolver = throwingResolver();
    const result = await loadConfiguredAdapters({
      validators: [entry("some-package"), entry("builtin")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: { workspaceTrusted: true, externalAdapters: "disabled" },
      builtins,
      moduleResolver,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        specifier: "some-package",
        kind: "external-adapters-disabled",
      }),
    ]);
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "builtin", enabled: true }),
    ]);
    expect(moduleResolver).not.toHaveBeenCalled();
  });

  it("fails workspace-not-trusted while other entries still load", async () => {
    const builtins = new Map([["builtin", stubAdapter("builtin")]]);
    const moduleResolver = throwingResolver();
    const result = await loadConfiguredAdapters({
      validators: [entry("some-package"), entry("builtin")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: {
        workspaceTrusted: false,
        externalAdapters: "trusted-workspace-only",
      },
      builtins,
      moduleResolver,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        specifier: "some-package",
        kind: "workspace-not-trusted",
      }),
    ]);
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "builtin", enabled: true }),
    ]);
    expect(moduleResolver).not.toHaveBeenCalled();
  });

  it("distinguishes invalid-specifier, resolution-failed, import-threw, invalid-shape, and api-version-mismatch, isolated per entry", async () => {
    const builtins = new Map([["builtin", stubAdapter("builtin")]]);
    const moduleResolver: AdapterModuleResolver = vi.fn(
      async (specifier: string) => {
        switch (specifier) {
          case "unresolvable-package":
            throw new AdapterModuleResolutionError("not found");
          case "throwing-package":
            throw new Error("boom while evaluating");
          case "invalid-shape-package":
            // A correct apiVersion but missing displayName/capabilities/
            // createSession, so this is rejected for its shape, not for
            // apiVersion (checkHtmlValidatorAdapter checks apiVersion
            // first).
            return {
              default: {
                apiVersion: VALIDATOR_API_VERSION,
                id: "invalid-shape",
                not: "an adapter",
              },
            };
          case "wrong-version-package":
            return {
              default: { ...stubAdapter("wrong-version"), apiVersion: 999 },
            };
          default:
            throw new Error(`unexpected specifier: ${specifier}`);
        }
      },
    );

    const result = await loadConfiguredAdapters({
      validators: [
        entry("../not-a-package"),
        entry("unresolvable-package"),
        entry("throwing-package"),
        entry("invalid-shape-package"),
        entry("wrong-version-package"),
        entry("builtin"),
      ],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
      moduleResolver,
    });

    expect(result.failures).toEqual([
      expect.objectContaining({
        specifier: "../not-a-package",
        kind: "invalid-specifier",
      }),
      expect.objectContaining({
        specifier: "unresolvable-package",
        kind: "resolution-failed",
      }),
      expect.objectContaining({
        specifier: "throwing-package",
        kind: "import-threw",
      }),
      expect.objectContaining({
        specifier: "invalid-shape-package",
        kind: "invalid-shape",
      }),
      expect.objectContaining({
        specifier: "wrong-version-package",
        kind: "api-version-mismatch",
      }),
    ]);
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "builtin", enabled: true }),
    ]);
    // The invalid specifier never reaches the resolver; the other four do.
    expect(moduleResolver).toHaveBeenCalledTimes(4);
    expect(moduleResolver).not.toHaveBeenCalledWith(
      "../not-a-package",
      WORKSPACE_ROOT,
    );
  });
});

describe("loadConfiguredAdapters: built-in injection (adapter-loader.md §6 item 2)", () => {
  it("loads a matching built-in id without touching the module resolver", async () => {
    const builtins = new Map([["markuplint", stubAdapter("markuplint")]]);
    const moduleResolver = throwingResolver();
    const result = await loadConfiguredAdapters({
      validators: [entry("markuplint")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: { workspaceTrusted: false, externalAdapters: "disabled" },
      builtins,
      moduleResolver,
    });
    expect(result.failures).toEqual([]);
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]?.adapter.id).toBe("markuplint");
    expect(result.adapters[0]?.enabled).toBe(true);
    expect(moduleResolver).not.toHaveBeenCalled();
  });

  it("still fails a built-in with a mismatched apiVersion", async () => {
    const builtins = new Map([
      [
        "markuplint",
        {
          ...stubAdapter("markuplint"),
          apiVersion: 999,
        } as unknown as HtmlValidatorAdapter<unknown>,
      ],
    ]);
    const result = await loadConfiguredAdapters({
      validators: [entry("markuplint")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
    });
    expect(result.adapters).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        specifier: "markuplint",
        kind: "api-version-mismatch",
      }),
    ]);
  });

  it("still fails a disabled built-in with an invalid shape", async () => {
    const builtins = new Map([
      [
        "markuplint",
        {
          apiVersion: VALIDATOR_API_VERSION,
          id: "markuplint",
        } as unknown as HtmlValidatorAdapter<unknown>,
      ],
    ]);
    const result = await loadConfiguredAdapters({
      validators: [entry("markuplint", { enabled: false })],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
    });
    expect(result.adapters).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        specifier: "markuplint",
        kind: "invalid-shape",
      }),
    ]);
  });
});

describe("loadConfiguredAdapters: specifier validation (adapter-loader.md §6 item 3)", () => {
  it("rejects paths, relative specifiers, URLs, and data URIs without a resolution attempt", async () => {
    const moduleResolver = throwingResolver();
    const specifiers = [
      "./local-adapter",
      "../local-adapter",
      "/abs/path/adapter",
      "https://example.com/adapter.js",
      "data:text/javascript;base64,ZXhwb3J0",
    ];
    const result = await loadConfiguredAdapters({
      validators: specifiers.map((specifier) => entry(specifier)),
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins: new Map(),
      moduleResolver,
    });
    expect(result.adapters).toEqual([]);
    expect(result.failures.map((failure) => failure.kind)).toEqual(
      specifiers.map(() => "invalid-specifier"),
    );
    expect(moduleResolver).not.toHaveBeenCalled();
  });
});

describe("loadConfiguredAdapters: duplicate-runtime-id (adapter-loader.md §6 item 4)", () => {
  it("keeps the first entry deterministically and fails the later one", async () => {
    const builtins = new Map([["builtin", stubAdapter("shared-id")]]);
    const moduleResolver: AdapterModuleResolver = vi.fn(async () => ({
      default: stubAdapter("shared-id"),
    }));
    const result = await loadConfiguredAdapters({
      validators: [entry("builtin"), entry("external-package")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
      moduleResolver,
    });
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "builtin", enabled: true }),
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        specifier: "external-package",
        kind: "duplicate-runtime-id",
      }),
    ]);
  });

  it("excludes a disabled external placeholder's fabricated id from the check, even if it textually matches a real id", async () => {
    // The builtin's map key ("builtin-x") differs from its real `.id`
    // ("actual-runtime-id"); the disabled external entry's specifier is
    // chosen to equal that real id, so its fabricated placeholder id
    // (always === entryKey) textually collides with it. This must not
    // produce a duplicate-runtime-id failure, because the placeholder's id
    // is never a *real*, imported id.
    const builtins = new Map([["builtin-x", stubAdapter("actual-runtime-id")]]);
    const moduleResolver = throwingResolver();
    const result = await loadConfiguredAdapters({
      validators: [
        entry("builtin-x"),
        entry("actual-runtime-id", { enabled: false }),
      ],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
      moduleResolver,
    });
    expect(result.failures).toEqual([]);
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "builtin-x", enabled: true }),
      expect.objectContaining({
        entryKey: "actual-runtime-id",
        enabled: false,
      }),
    ]);
    expect(moduleResolver).not.toHaveBeenCalled();
  });
});

describe("loadConfiguredAdapters: disabled entries (adapter-loader.md §6 item 5)", () => {
  it("never imports a disabled external adapter, but returns it disabled", async () => {
    const moduleResolver = throwingResolver();
    const result = await loadConfiguredAdapters({
      validators: [entry("external-package", { enabled: false })],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins: new Map(),
      moduleResolver,
    });
    expect(result.failures).toEqual([]);
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "external-package", enabled: false }),
    ]);
    expect(moduleResolver).not.toHaveBeenCalled();
  });

  it("returns a disabled built-in without invoking the resolver", async () => {
    const builtins = new Map([["markuplint", stubAdapter("markuplint")]]);
    const moduleResolver = throwingResolver();
    const result = await loadConfiguredAdapters({
      validators: [entry("markuplint", { enabled: false })],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
      moduleResolver,
    });
    expect(result.adapters).toEqual([
      expect.objectContaining({ entryKey: "markuplint", enabled: false }),
    ]);
    expect(moduleResolver).not.toHaveBeenCalled();
  });
});

describe("loadConfiguredAdapters: determinism (adapter-loader.md §6 item 6)", () => {
  it("produces the same adapter order, failure order, and dedupe keys across runs", async () => {
    const builtins = new Map([["builtin", stubAdapter("builtin")]]);
    const moduleResolver: AdapterModuleResolver = vi.fn(
      async (specifier: string) => {
        if (specifier === "valid-package") {
          return { default: stubAdapter("valid-package") };
        }
        throw new AdapterModuleResolutionError("nope");
      },
    );
    const request = {
      validators: [
        entry("builtin"),
        entry("valid-package"),
        entry("missing-package"),
      ],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins,
      moduleResolver,
    };
    const first = await loadConfiguredAdapters(request);
    const second = await loadConfiguredAdapters(request);

    const shape = (
      result: Awaited<ReturnType<typeof loadConfiguredAdapters>>,
    ) => ({
      adapters: result.adapters.map((loaded) => ({
        entryKey: loaded.entryKey,
        enabled: loaded.enabled,
        id: loaded.adapter.id,
      })),
      failures: result.failures,
    });
    expect(shape(first)).toEqual(shape(second));
  });

  it("deduplicates failures with the same dedupeKey, keeping the first occurrence", async () => {
    const result = await loadConfiguredAdapters({
      validators: [entry("./same-bad-path"), entry("./same-bad-path")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins: new Map(),
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual(
      expect.objectContaining({
        specifier: "./same-bad-path",
        kind: "invalid-specifier",
        dedupeKey: "./same-bad-path:invalid-specifier",
      }),
    );
  });
});

describe("loadConfiguredAdapters: successful external load", () => {
  it("loads a trusted, resolvable, valid external adapter", async () => {
    const moduleResolver: AdapterModuleResolver = vi.fn(async () => ({
      default: stubAdapter("external-adapter"),
    }));
    const result = await loadConfiguredAdapters({
      validators: [entry("external-package", { settings: { foo: "bar" } })],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins: new Map(),
      moduleResolver,
    });
    expect(result.failures).toEqual([]);
    expect(result.adapters).toEqual([
      {
        adapter: expect.objectContaining({ id: "external-adapter" }),
        settings: { foo: "bar" },
        enabled: true,
        entryKey: "external-package",
      },
    ]);
    expect(moduleResolver).toHaveBeenCalledWith(
      "external-package",
      WORKSPACE_ROOT,
    );
  });

  it("accepts a module whose export is not wrapped in `default`", async () => {
    const moduleResolver: AdapterModuleResolver = vi.fn(async () =>
      stubAdapter("bare-export-adapter"),
    );
    const result = await loadConfiguredAdapters({
      validators: [entry("external-package")],
      workspaceRoot: WORKSPACE_ROOT,
      trust: TRUSTED,
      builtins: new Map(),
      moduleResolver,
    });
    expect(result.failures).toEqual([]);
    expect(result.adapters[0]?.adapter.id).toBe("bare-export-adapter");
  });
});
