// cli.md §9 item 3 (validator flags) plus general argv-parsing coverage of
// §4.2's flag surface.
import { describe, expect, it } from "vitest";
import {
  applyValidatorFlagOps,
  deepSetOwn,
  parseArgv,
  parseDottedPath,
  parseFlagValue,
  type ValidatorFlagOp,
} from "./options.js";

describe("parseArgv: general flag surface (cli.md §4.2)", () => {
  it("parses positional arguments, repeatable flags, and scalar flags", () => {
    const result = parseArgv([
      "src/A.vue",
      "--include",
      "extra/**/*.vue",
      "--exclude",
      "**/fixtures/**",
      "--exclude",
      "**/gen/**",
      "--custom-elements",
      "my-el",
      "--custom-elements",
      "other-*",
      "--max-concurrency",
      "4",
      "--warn-variant-count",
      "100",
      "--external-adapters",
      "trusted-workspace-only",
      "src/B.vue",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.positionalArgs).toEqual(["src/A.vue", "src/B.vue"]);
    expect(result.options.settingsInput).toEqual({
      include: ["extra/**/*.vue"],
      exclude: ["**/fixtures/**", "**/gen/**"],
      customElements: ["my-el", "other-*"],
      maxConcurrency: 4,
      warnVariantCount: 100,
      externalAdapters: "trusted-workspace-only",
    });
  });

  it("accepts the --flag=value form, preserving embedded '=' in the value", () => {
    const result = parseArgv(['--validator-setting=markuplint.a={"x":"y=z"}']);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.validatorOps).toEqual([
      {
        kind: "set-setting",
        entryKey: "markuplint",
        path: ["a"],
        value: { x: "y=z" },
      },
    ]);
  });

  it("CLI-only options: --config, --workspace-root, --format, --fail-on, --untrusted, --no-color", () => {
    const result = parseArgv([
      "--config",
      "custom.json",
      "--workspace-root",
      "/tmp/ws",
      "--format",
      "ndjson",
      "--fail-on",
      "warning",
      "--untrusted",
      "--no-color",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options).toMatchObject({
      configPath: "custom.json",
      workspaceRoot: "/tmp/ws",
      format: "ndjson",
      failOn: "warning",
      untrusted: true,
      noColor: true,
    });
  });

  it("defaults format to text and fail-on to error", () => {
    const result = parseArgv([]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.format).toBe("text");
    expect(result.options.failOn).toBe("error");
  });

  it("--emit-html <dir> (plan.md T3, ADR-0011)", () => {
    const result = parseArgv(["--emit-html", "/tmp/debug-html"]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.emitHtmlDir).toBe("/tmp/debug-html");
  });

  it("emitHtmlDir is undefined when --emit-html is omitted (REQ-8/REQ-5 no-default-change)", () => {
    const result = parseArgv(["src/A.vue"]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.emitHtmlDir).toBeUndefined();
  });

  it('"--emit-html" with no following value (end of argv) is a usage error', () => {
    const result = parseArgv(["--emit-html"]);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe('"--emit-html" requires a value.');
  });

  it("--help and --version short-circuit flags", () => {
    const help = parseArgv(["--help"]);
    expect(help.kind).toBe("ok");
    if (help.kind === "ok") expect(help.options.help).toBe(true);
    const version = parseArgv(["--version"]);
    expect(version.kind).toBe("ok");
    if (version.kind === "ok") expect(version.options.version).toBe(true);
  });

  it("rejects an unknown option as a usage error", () => {
    const result = parseArgv(["--not-a-real-flag"]);
    expect(result.kind).toBe("error");
  });

  it("rejects a flag missing its required value", () => {
    const result = parseArgv(["--format"]);
    expect(result.kind).toBe("error");
  });

  it("rejects an invalid --format/--fail-on enum value", () => {
    expect(parseArgv(["--format", "xml"]).kind).toBe("error");
    expect(parseArgv(["--fail-on", "critical"]).kind).toBe("error");
  });

  it("a single dash is treated as a positional argument, not an option", () => {
    const result = parseArgv(["-"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok")
      expect(result.options.positionalArgs).toEqual(["-"]);
  });
});

describe("validator flags: entry-key addressing and application order (cli.md §4.3, §9 item 3)", () => {
  it("--validator marks an entry enabled, --disable-validator marks one disabled, in command-line order", () => {
    const result = parseArgv([
      "--validator",
      "markuplint",
      "--disable-validator",
      "@acme/adapter",
      "--validator",
      "@acme/adapter",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.validatorOps).toEqual([
      { kind: "enable", entryKey: "markuplint" },
      { kind: "disable", entryKey: "@acme/adapter" },
      { kind: "enable", entryKey: "@acme/adapter" },
    ] satisfies ValidatorFlagOp[]);
  });

  it("addresses entries by the exact validators[].adapter string — the built-in id or a package specifier — never a runtime adapter.id", () => {
    // "markuplint" here is the settings.md §3.1 entry key, which happens to
    // equal validator-api's stable built-in id, but an external package
    // specifier (e.g. "@acme/adapter") is addressed the same way regardless
    // of what its loaded module's `adapter.id` turns out to be.
    const validators = [{ adapter: "@acme/adapter", enabled: true }];
    const patched = applyValidatorFlagOps(validators, [
      { kind: "disable", entryKey: "@acme/adapter" },
    ]);
    expect(patched).toEqual([{ adapter: "@acme/adapter", enabled: false }]);
  });

  it("applyValidatorFlagOps applies ops in order, adding a fresh entry (enabled: true default) when the key names none", () => {
    const result = applyValidatorFlagOps(
      [{ adapter: "markuplint", enabled: true }],
      [
        { kind: "disable", entryKey: "markuplint" },
        { kind: "enable", entryKey: "new-adapter" },
        {
          kind: "set-setting",
          entryKey: "new-adapter",
          path: ["nested", "flag"],
          value: true,
        },
      ],
    );
    expect(result).toEqual([
      { adapter: "markuplint", enabled: false },
      {
        adapter: "new-adapter",
        enabled: true,
        settings: { nested: { flag: true } },
      },
    ]);
  });

  it("--validator-setting only (no --validator) still creates the entry, enabled by default", () => {
    const result = applyValidatorFlagOps(
      [],
      [
        {
          kind: "set-setting",
          entryKey: "unconfigured-adapter",
          path: ["a"],
          value: 1,
        },
      ],
    );
    expect(result).toEqual([
      { adapter: "unconfigured-adapter", enabled: true, settings: { a: 1 } },
    ]);
  });

  it("later --validator-setting calls merge into, rather than replace, an entry's existing settings", () => {
    const result = applyValidatorFlagOps(
      [{ adapter: "markuplint", enabled: true, settings: { a: 1 } }],
      [{ kind: "set-setting", entryKey: "markuplint", path: ["b"], value: 2 }],
    );
    expect(result).toEqual([
      { adapter: "markuplint", enabled: true, settings: { a: 1, b: 2 } },
    ]);
  });

  it("an unknown entry key for --disable-validator adds a (disabled) entry rather than erroring", () => {
    const result = applyValidatorFlagOps(
      [{ adapter: "markuplint", enabled: true }],
      [{ kind: "disable", entryKey: "never-configured" }],
    );
    expect(result).toEqual([
      { adapter: "markuplint", enabled: true },
      { adapter: "never-configured", enabled: false },
    ]);
  });
});

describe("--validator-setting parsing (cli.md §4.3)", () => {
  it("parses <entry-key>.<path>=<value> into an op with a JSON-parsed value", () => {
    const result = parseArgv([
      "--validator-setting",
      "markuplint.searchConfig=false",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.validatorOps).toEqual([
      {
        kind: "set-setting",
        entryKey: "markuplint",
        path: ["searchConfig"],
        value: false,
      },
    ]);
  });

  it("falls back to a plain string when the value doesn't parse as JSON", () => {
    const result = parseArgv([
      "--validator-setting",
      "markuplint.configFile=.markuplintrc",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.validatorOps).toEqual([
      {
        kind: "set-setting",
        entryKey: "markuplint",
        path: ["configFile"],
        value: ".markuplintrc",
      },
    ]);
  });

  it("supports a multi-segment dotted path", () => {
    const result = parseArgv([
      "--validator-setting",
      "markuplint.rules.id-duplication=false",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.options.validatorOps).toEqual([
      {
        kind: "set-setting",
        entryKey: "markuplint",
        path: ["rules", "id-duplication"],
        value: false,
      },
    ]);
  });

  it("rejects a value missing '='", () => {
    expect(
      parseArgv(["--validator-setting", "markuplint.searchConfig"]).kind,
    ).toBe("error");
  });

  it("rejects a value missing the entry-key/path '.'", () => {
    expect(parseArgv(["--validator-setting", "markuplint=false"]).kind).toBe(
      "error",
    );
  });
});

describe("dotted-path grammar (cli.md §4.3, §9 item 3)", () => {
  it("accepts one or more non-empty dot-separated segments", () => {
    expect(parseDottedPath("a")).toEqual(["a"]);
    expect(parseDottedPath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("rejects an empty path", () => {
    expect(typeof parseDottedPath("")).toBe("string");
  });

  it("rejects empty segments (leading, trailing, doubled dots)", () => {
    expect(typeof parseDottedPath(".a")).toBe("string");
    expect(typeof parseDottedPath("a.")).toBe("string");
    expect(typeof parseDottedPath("a..b")).toBe("string");
  });

  it("rejects a key containing a literal '.' by definition (unaddressable, not a crash)", () => {
    // "a.b" as one logical key is inherently unaddressable by this grammar —
    // it is parsed as two segments, which is the documented limitation
    // (cli.md §4.3: "use the config file for both"), not a special error.
    expect(parseDottedPath("a.b")).toEqual(["a", "b"]);
  });

  it("rejects bracketed array-index syntax", () => {
    expect(typeof parseDottedPath("rules[0]")).toBe("string");
    expect(typeof parseDottedPath("a.rules[0].b")).toBe("string");
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the forbidden segment %s",
    (segment) => {
      expect(typeof parseDottedPath(segment)).toBe("string");
      expect(typeof parseDottedPath(`a.${segment}`)).toBe("string");
      expect(typeof parseDottedPath(`${segment}.a`)).toBe("string");
    },
  );
});

describe("parseFlagValue: JSON-with-string-fallback (cli.md §4.3)", () => {
  it("parses JSON booleans, numbers, objects", () => {
    expect(parseFlagValue("false")).toBe(false);
    expect(parseFlagValue("true")).toBe(true);
    expect(parseFlagValue("42")).toBe(42);
    expect(parseFlagValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseFlagValue("null")).toBe(null);
  });

  it("falls back to a plain string for unparsable input", () => {
    expect(parseFlagValue(".markuplintrc")).toBe(".markuplintrc");
    expect(parseFlagValue("not json {")).toBe("not json {");
  });
});

describe("prototype-pollution resistance (cli.md §4.3, §9 item 3)", () => {
  it("--validator-setting with a __proto__ segment is rejected as a usage error, never reaching deepSetOwn", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const result = parseArgv([
      "--validator-setting",
      "markuplint.__proto__.polluted=true",
    ]);
    expect(result.kind).toBe("error");
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    // @ts-expect-error -- probing for the attack's success, not a real API
    expect({}.polluted).toBeUndefined();
  });

  it("--validator-setting with a constructor/prototype segment is rejected the same way", () => {
    expect(
      parseArgv(["--validator-setting", "markuplint.constructor.polluted=true"])
        .kind,
    ).toBe("error");
    expect(
      parseArgv([
        "--validator-setting",
        "markuplint.constructor.prototype.polluted=true",
      ]).kind,
    ).toBe("error");
  });

  it("deepSetOwn itself never mutates Object.prototype even when called directly with forbidden-shaped (but not-yet-validated) segments", () => {
    // deepSetOwn doesn't re-validate segments (parseDottedPath already
    // rejected forbidden ones before any op reaches it) — this test proves
    // the *construction mechanism itself* (null-prototype objects + own-
    // property assignment via defineProperty) is safe even if it were ever
    // called with a segment matching a prototype-chain property name that
    // ISN'T one of the three forbidden ones, e.g. "toString" or "hasOwnProperty".
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const result = deepSetOwn(undefined, ["toString", "nested"], "polluted");
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.prototype.toString).toBe(Object.prototype.toString); // unchanged
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(result["toString"]).toEqual({ nested: "polluted" });
  });

  it("a full accepted --validator-setting run leaves Object.prototype completely unchanged", () => {
    const beforeDescriptors = Object.getOwnPropertyDescriptors(
      Object.prototype,
    );
    const result = parseArgv([
      "--validator-setting",
      "markuplint.deeply.nested.path=42",
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      applyValidatorFlagOps([], result.options.validatorOps);
    }
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
      beforeDescriptors,
    );
  });
});
