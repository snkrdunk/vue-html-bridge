import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AdapterModuleResolutionError,
  nodeModuleResolver,
} from "./resolver.js";

// This package's own directory: pnpm symlinks its real dependencies (e.g.
// @vue-html-bridge/validator-api) into node_modules here, so resolution
// rooted at this directory can be exercised end to end without a fake.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("nodeModuleResolver", () => {
  it("resolves and imports a real installed package rooted at workspaceRoot", async () => {
    const imported = (await nodeModuleResolver(
      "@vue-html-bridge/validator-api",
      packageRoot,
    )) as { PACKAGE_NAME?: unknown };
    expect(imported.PACKAGE_NAME).toBe("@vue-html-bridge/validator-api");
  });

  it("throws AdapterModuleResolutionError for an unresolvable package", async () => {
    await expect(
      nodeModuleResolver(
        "@vue-html-bridge/this-package-does-not-exist",
        packageRoot,
      ),
    ).rejects.toBeInstanceOf(AdapterModuleResolutionError);
  });
});
