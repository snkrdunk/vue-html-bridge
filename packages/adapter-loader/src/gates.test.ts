import { describe, expect, it } from "vitest";
import {
  isExternalAdaptersModeEnabled,
  isPlainPackageSpecifier,
  isWorkspaceTrusted,
} from "./gates.js";

describe("isExternalAdaptersModeEnabled", () => {
  it("is true only for trusted-workspace-only", () => {
    expect(
      isExternalAdaptersModeEnabled({
        workspaceTrusted: true,
        externalAdapters: "trusted-workspace-only",
      }),
    ).toBe(true);
    expect(
      isExternalAdaptersModeEnabled({
        workspaceTrusted: true,
        externalAdapters: "disabled",
      }),
    ).toBe(false);
  });
});

describe("isWorkspaceTrusted", () => {
  it("reflects trust.workspaceTrusted", () => {
    expect(
      isWorkspaceTrusted({
        workspaceTrusted: true,
        externalAdapters: "disabled",
      }),
    ).toBe(true);
    expect(
      isWorkspaceTrusted({
        workspaceTrusted: false,
        externalAdapters: "disabled",
      }),
    ).toBe(false);
  });
});

describe("isPlainPackageSpecifier", () => {
  it("accepts plain and scoped package names", () => {
    expect(isPlainPackageSpecifier("my-adapter")).toBe(true);
    expect(isPlainPackageSpecifier("my_adapter.thing")).toBe(true);
    expect(isPlainPackageSpecifier("@scope/my-adapter")).toBe(true);
  });

  it("rejects relative and absolute paths", () => {
    expect(isPlainPackageSpecifier("./local-adapter")).toBe(false);
    expect(isPlainPackageSpecifier("../local-adapter")).toBe(false);
    expect(isPlainPackageSpecifier("/abs/path/adapter")).toBe(false);
  });

  it("rejects URLs and data URIs", () => {
    expect(isPlainPackageSpecifier("https://example.com/adapter.js")).toBe(
      false,
    );
    expect(isPlainPackageSpecifier("file:///abs/path/adapter.js")).toBe(false);
    expect(
      isPlainPackageSpecifier("data:text/javascript;base64,ZXhwb3J0"),
    ).toBe(false);
  });

  it("rejects Windows-style paths", () => {
    expect(isPlainPackageSpecifier("C:\\adapters\\my-adapter")).toBe(false);
    expect(isPlainPackageSpecifier("C:/adapters/my-adapter")).toBe(false);
  });

  it("rejects subpaths, empty strings, and padded whitespace", () => {
    expect(isPlainPackageSpecifier("my-adapter/sub/path")).toBe(false);
    expect(isPlainPackageSpecifier("@scope/my-adapter/sub")).toBe(false);
    expect(isPlainPackageSpecifier("")).toBe(false);
    expect(isPlainPackageSpecifier(" my-adapter ")).toBe(false);
  });

  it("rejects a malformed scope", () => {
    expect(isPlainPackageSpecifier("@scope-only")).toBe(false);
    expect(isPlainPackageSpecifier("@/my-adapter")).toBe(false);
  });
});
