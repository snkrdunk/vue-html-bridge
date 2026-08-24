import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, runVueHtmlBridgeCli } from "./index.js";

describe("@vue-html-bridge/cli package surface", () => {
  it("exposes its own package name", () => {
    expect(PACKAGE_NAME).toBe("@vue-html-bridge/cli");
  });

  it("--help prints usage to stdout and exits 0, through the public entry point", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runVueHtmlBridgeCli({
      argv: ["--help"],
      cwd: process.cwd(),
      writeStdout: (chunk) => stdout.push(chunk),
      writeStderr: (chunk) => stderr.push(chunk),
      signal: new AbortController().signal,
      version: "0.0.0-test",
    });
    expect(result).toEqual({ interrupted: false, exitCode: 0 });
    expect(stdout.join("")).toContain("Usage: vue-html-bridge");
    expect(stderr).toEqual([]);
  });
});
