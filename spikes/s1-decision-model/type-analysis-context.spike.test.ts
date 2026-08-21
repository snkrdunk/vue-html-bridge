import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectDecisions } from "./decision-collector.js";
import { findPropsTypeArg } from "./find-props-type.js";
import {
  createCoreOwnedContext,
  createInjectedContext,
} from "./type-analysis-context.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("S1 spike: cross-file type resolution (ADR-0002 evidence)", () => {
  it("resolves a prop's type through a local type alias that itself imports a cross-file union (role-badge.vue -> shared-types.ts)", () => {
    const filename = fixture("role-badge.vue");
    const source = readFileSync(filename, "utf-8");
    const ctx = createInjectedContext(new Map());
    const result = collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
    const role = result.resolvedProps.find((p) => p.name === "role");
    expect(role?.domain).toEqual({
      kind: "literal-union",
      values: ["admin", "member"],
      nullable: false,
    });
  });

  it("resolves the whole *outer* props shape through a cross-file interface reference (defineProps<Props>() imported from props-shape.ts)", () => {
    const filename = fixture("imported-props-shape.vue");
    const source = readFileSync(filename, "utf-8");
    const ctx = createInjectedContext(new Map());
    const result = collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
    const role = result.resolvedProps.find((p) => p.name === "role");
    expect(role?.domain).toEqual({
      kind: "literal-union",
      values: ["admin", "member"],
      nullable: false,
    });
  });

  it("honors an unsaved-buffer override for the SFC's own script content", () => {
    const filename = fixture("role-badge.vue");
    const diskSource = readFileSync(filename, "utf-8");
    const unsavedSource = diskSource.replace(
      "defineProps<{ role: Role }>()",
      "defineProps<{ role: Role; extra: boolean }>()",
    );
    expect(unsavedSource).not.toBe(diskSource);

    const ctx = createInjectedContext(new Map());
    // The SFC's own content is always whatever the caller passes as
    // `source` — core never reads its own file from `fs`, so "unsaved
    // buffer" support for the SFC itself is trivially satisfied by the
    // public API shape (GenerateRequest.source), not by this fs seam.
    const result = collectDecisions(
      filename,
      unsavedSource,
      findPropsTypeArg,
      ctx.fs,
    );
    expect(result.resolvedProps.map((p) => p.name).sort()).toEqual([
      "extra",
      "role",
    ]);
  });

  it("honors an unsaved-buffer override for an IMPORTED dependency file, through the injected fs — this is the real cross-file unsaved-buffer case", () => {
    const filename = fixture("role-badge.vue");
    const source = readFileSync(filename, "utf-8");
    const sharedTypesFile = fixture("shared-types.ts");
    const diskSharedTypes = readFileSync(sharedTypesFile, "utf-8");
    const unsavedSharedTypes =
      'export type Role = "admin" | "member" | "guest";\n';
    expect(unsavedSharedTypes).not.toBe(diskSharedTypes);

    const overrides = new Map([[sharedTypesFile, unsavedSharedTypes]]);
    const ctx = createInjectedContext(overrides);
    const result = collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
    const role = result.resolvedProps.find((p) => p.name === "role");
    expect(role?.domain).toEqual({
      kind: "literal-union",
      values: ["admin", "member", "guest"],
      nullable: false,
    });
  });

  it("requires explicit invalidate() to see a changed dependency across two resolutions in the SAME process — proving the underlying caches (Vue's private fileToScopeCache + this module's own scope cache) are real and not per-call-fresh by default", () => {
    const filename = fixture("imported-props-shape.vue");
    const source = readFileSync(filename, "utf-8");
    const propsShapeFile = fixture("props-shape.ts");
    const diskPropsShape = readFileSync(propsShapeFile, "utf-8");

    const overrides = new Map<string, string>();
    const ctx = createInjectedContext(overrides);

    const first = collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
    expect(first.resolvedProps.find((p) => p.name === "role")?.domain).toEqual({
      kind: "literal-union",
      values: ["admin", "member"],
      nullable: false,
    });

    // Mutate the override WITHOUT invalidating — Vue's `resolveTypeElements`
    // resolved `Props` (the outer shape) through its own private cache the
    // first time, keyed only by filename, so a second resolution without
    // invalidation must still see the OLD shape.
    overrides.set(
      propsShapeFile,
      'export interface Props {\n  role: "admin" | "member" | "guest";\n}\n',
    );
    const stale = collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
    expect(stale.resolvedProps.find((p) => p.name === "role")?.domain).toEqual({
      kind: "literal-union",
      values: ["admin", "member"], // still old — proves the cache is real
      nullable: false,
    });

    ctx.invalidate([propsShapeFile]);
    const fresh = collectDecisions(filename, source, findPropsTypeArg, ctx.fs);
    expect(fresh.resolvedProps.find((p) => p.name === "role")?.domain).toEqual({
      kind: "literal-union",
      values: ["admin", "member", "guest"],
      nullable: false,
    });

    // Cleanup: leave the shared caches in a state that doesn't leak into
    // other test files' assertions about props-shape.ts.
    overrides.set(propsShapeFile, diskPropsShape);
    ctx.invalidate([propsShapeFile]);
  });

  it("a core-owned context (model a) has no per-file signal — invalidate() can only do a full epoch bump, never a targeted one", () => {
    const ctx = createCoreOwnedContext();
    expect(ctx.epoch).toBe(0);
    ctx.invalidate(["/some/file/that/was/never/named.ts"]);
    expect(ctx.epoch).toBe(1); // bumped regardless of the (irrelevant) filename passed in
  });
});
