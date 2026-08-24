import { describe, expect, it } from "vitest";
import type { SettingsFileSystem } from "@vue-html-bridge/settings";
import {
  resolveWorkspaceSettings,
  type ConfigurationClient,
} from "./sources.js";

const ROOT = "/workspace";

function fakeFileSystem(files: Record<string, string>): SettingsFileSystem {
  return {
    async readFile(absolutePath) {
      return Object.hasOwn(files, absolutePath)
        ? files[absolutePath]
        : undefined;
    },
  };
}

function fakeClient(value: unknown): ConfigurationClient {
  return {
    async getConfiguration() {
      return value;
    },
  };
}

describe("resolveWorkspaceSettings (language-server.md §9.2)", () => {
  it("uses discovered-file settings when no workspace/configuration is supported and no init settings are given", async () => {
    const result = await resolveWorkspaceSettings({
      workspaceRoot: ROOT,
      initializationSettings: undefined,
      supportsWorkspaceConfiguration: false,
      configurationClient: fakeClient(undefined),
      fileSystem: fakeFileSystem({
        [`${ROOT}/.vue-html-bridge.json`]: JSON.stringify({
          debounceMs: 500,
        }),
      }),
    });
    expect(result.settings.debounceMs).toBe(500);
    expect(result.issues).toEqual([]);
    expect(result.sourcePath).toBe(`${ROOT}/.vue-html-bridge.json`);
  });

  it("layers initializationSettings over the discovered file when the client lacks workspace/configuration support", async () => {
    const result = await resolveWorkspaceSettings({
      workspaceRoot: ROOT,
      initializationSettings: { debounceMs: 250 },
      supportsWorkspaceConfiguration: false,
      configurationClient: fakeClient(undefined),
      fileSystem: fakeFileSystem({
        [`${ROOT}/.vue-html-bridge.json`]: JSON.stringify({
          debounceMs: 500,
          include: ["**/*.vue"],
        }),
      }),
    });
    expect(result.settings.debounceMs).toBe(250);
    expect(result.settings.include).toEqual(["**/*.vue"]);
  });

  it("prefers workspace/configuration over the discovered file when the client supports it", async () => {
    const result = await resolveWorkspaceSettings({
      workspaceRoot: ROOT,
      initializationSettings: { debounceMs: 250 },
      supportsWorkspaceConfiguration: true,
      configurationClient: fakeClient({ debounceMs: 999 }),
      fileSystem: fakeFileSystem({
        [`${ROOT}/.vue-html-bridge.json`]: JSON.stringify({
          debounceMs: 500,
        }),
      }),
    });
    expect(result.settings.debounceMs).toBe(999);
  });

  it("falls back to initializationSettings when workspace/configuration is supported but the request fails", async () => {
    const failingClient: ConfigurationClient = {
      async getConfiguration() {
        throw new Error("client doesn't actually implement this");
      },
    };
    const result = await resolveWorkspaceSettings({
      workspaceRoot: ROOT,
      initializationSettings: { debounceMs: 250 },
      supportsWorkspaceConfiguration: true,
      configurationClient: failingClient,
      fileSystem: fakeFileSystem({}),
    });
    expect(result.settings.debounceMs).toBe(250);
  });

  it("surfaces discovered-file issues alongside the resolved settings", async () => {
    const result = await resolveWorkspaceSettings({
      workspaceRoot: ROOT,
      initializationSettings: undefined,
      supportsWorkspaceConfiguration: false,
      configurationClient: fakeClient(undefined),
      fileSystem: fakeFileSystem({
        [`${ROOT}/.vue-html-bridge.json`]: "{ not valid json",
      }),
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe("parse-error");
  });

  it("applies package defaults when neither a file nor any top layer defines a field", async () => {
    const result = await resolveWorkspaceSettings({
      workspaceRoot: ROOT,
      initializationSettings: undefined,
      supportsWorkspaceConfiguration: false,
      configurationClient: fakeClient(undefined),
      fileSystem: fakeFileSystem({}),
    });
    expect(result.settings.enabled).toBe(true);
    expect(result.sourcePath).toBeUndefined();
  });
});
