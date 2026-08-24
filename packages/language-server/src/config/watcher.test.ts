import { describe, expect, it } from "vitest";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import type { WorkspaceSession } from "../workspace/session.js";
import {
  buildWatchRegistrationPlan,
  matchConfigChange,
  watchPlansEqual,
} from "./watcher.js";

function fakeSession(
  overrides: Partial<WorkspaceSession> = {},
): WorkspaceSession {
  return {
    folderRoot: "/workspace",
    analyzer: undefined as never,
    typeContext: undefined as never,
    settings: undefined as never,
    workspaceTrusted: true,
    configuredAdapters: [
      { adapter: markuplintAdapter, settings: {}, enabled: true },
    ],
    lastWatchTargets: [],
    reconfigure: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

describe("buildWatchRegistrationPlan (language-server.md §9.3)", () => {
  it("collects deduplicated, sorted candidate patterns from enabled adapters' capabilities", () => {
    const plan = buildWatchRegistrationPlan([fakeSession(), fakeSession()]);
    expect(plan.patternGlobs).toEqual(
      [...new Set(markuplintAdapter.capabilities.configFilePatterns)].sort(),
    );
  });

  it("excludes patterns from a disabled adapter entry", () => {
    const plan = buildWatchRegistrationPlan([
      fakeSession({
        configuredAdapters: [
          { adapter: markuplintAdapter, settings: {}, enabled: false },
        ],
      }),
    ]);
    expect(plan.patternGlobs).toEqual([]);
  });

  it("collects deduplicated, sorted concrete paths from each session's lastWatchTargets", () => {
    const plan = buildWatchRegistrationPlan([
      fakeSession({
        lastWatchTargets: [
          {
            absolutePath: "/workspace/b.config",
            kind: "config",
            adapterId: "markuplint",
          },
        ],
      }),
      fakeSession({
        lastWatchTargets: [
          {
            absolutePath: "/workspace/a.config",
            kind: "config",
            adapterId: "markuplint",
          },
          {
            absolutePath: "/workspace/b.config",
            kind: "config",
            adapterId: "markuplint",
          },
        ],
      }),
    ]);
    expect(plan.concreteAbsolutePaths).toEqual([
      "/workspace/a.config",
      "/workspace/b.config",
    ]);
  });
});

describe("watchPlansEqual", () => {
  it("is true for the same content regardless of array identity", () => {
    expect(
      watchPlansEqual(
        { patternGlobs: ["a", "b"], concreteAbsolutePaths: ["c"] },
        { patternGlobs: ["a", "b"], concreteAbsolutePaths: ["c"] },
      ),
    ).toBe(true);
  });

  it("is false when either list differs", () => {
    expect(
      watchPlansEqual(
        { patternGlobs: ["a"], concreteAbsolutePaths: [] },
        { patternGlobs: ["a", "b"], concreteAbsolutePaths: [] },
      ),
    ).toBe(false);
    expect(
      watchPlansEqual(
        { patternGlobs: [], concreteAbsolutePaths: ["c"] },
        { patternGlobs: [], concreteAbsolutePaths: ["d"] },
      ),
    ).toBe(false);
  });
});

describe("matchConfigChange (§9.3)", () => {
  it("attributes a known concrete target to its tagged adapter", () => {
    const session = fakeSession({
      lastWatchTargets: [
        {
          absolutePath: "/workspace/.markuplintrc",
          kind: "config",
          adapterId: "markuplint",
        },
      ],
    });
    const match = matchConfigChange([session], "/workspace/.markuplintrc");
    expect(match?.session).toBe(session);
    expect(match?.adapterIds).toEqual(["markuplint"]);
  });

  it("attributes a newly created file matching a candidate pattern to every matching enabled adapter", () => {
    const session = fakeSession();
    const newPath = "/workspace/nested/.markuplintrc";
    const match = matchConfigChange([session], newPath);
    expect(match?.session).toBe(session);
    expect(match?.adapterIds).toEqual(["markuplint"]);
  });

  it("returns undefined for a path matching neither a concrete target nor any pattern", () => {
    const session = fakeSession();
    expect(
      matchConfigChange([session], "/workspace/src/Component.vue"),
    ).toBeUndefined();
  });

  it("prefers the concrete-target match over a pattern match when both could apply", () => {
    const session = fakeSession({
      lastWatchTargets: [
        {
          absolutePath: "/workspace/.markuplintrc",
          kind: "config",
          adapterId: "markuplint",
        },
      ],
    });
    // Even though this also matches the "**/.markuplintrc" candidate
    // pattern, the concrete (already-resolved) attribution wins.
    const match = matchConfigChange([session], "/workspace/.markuplintrc");
    expect(match?.adapterIds).toEqual(["markuplint"]);
  });
});
