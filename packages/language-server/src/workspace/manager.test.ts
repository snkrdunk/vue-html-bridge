import { afterEach, describe, expect, it } from "vitest";
import { resolveSettings } from "@vue-html-bridge/settings";
import { createWorkspaceManager, type WorkspaceManager } from "./manager.js";

const managers: WorkspaceManager[] = [];

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.disposeAll()));
  managers.splice(0, managers.length);
});

function fakeManager(workspaceTrusted = true): WorkspaceManager {
  const manager = createWorkspaceManager({
    workspaceTrusted,
    resolveSettingsForFolder: async () => resolveSettings([]).settings,
  });
  managers.push(manager);
  return manager;
}

describe("createWorkspaceManager (language-server.md §9.1)", () => {
  it("addFolder creates one session per folder, keyed by fs path", async () => {
    const manager = fakeManager();
    const a = await manager.addFolder("file:///workspace/a");
    const b = await manager.addFolder("file:///workspace/b");
    expect(a).not.toBe(b);
    expect(a.folderRoot).toBe("/workspace/a");
    expect(b.folderRoot).toBe("/workspace/b");
    expect(manager.sessions()).toHaveLength(2);
  });

  it("addFolder is idempotent for the same folder", async () => {
    const manager = fakeManager();
    const first = await manager.addFolder("file:///workspace/a");
    const second = await manager.addFolder("file:///workspace/a");
    expect(first).toBe(second);
    expect(manager.sessions()).toHaveLength(1);
  });

  it("removeFolder disposes and forgets the session", async () => {
    const manager = fakeManager();
    await manager.addFolder("file:///workspace/a");
    await manager.removeFolder("file:///workspace/a");
    expect(manager.sessions()).toHaveLength(0);
  });

  it("removeFolder is a no-op for a folder that was never added", async () => {
    const manager = fakeManager();
    await expect(
      manager.removeFolder("file:///workspace/never-added"),
    ).resolves.toBeUndefined();
  });

  it("resolveForUri routes a document to its containing folder session", async () => {
    const manager = fakeManager();
    const a = await manager.addFolder("file:///workspace/a");
    await manager.addFolder("file:///workspace/b");
    const resolved = await manager.resolveForUri(
      "file:///workspace/a/src/Component.vue",
    );
    expect(resolved).toBe(a);
  });

  it("resolveForUri picks the longest-matching-prefix folder for nested roots", async () => {
    const manager = fakeManager();
    const outer = await manager.addFolder("file:///workspace");
    const inner = await manager.addFolder("file:///workspace/nested");
    const innerMatch = await manager.resolveForUri(
      "file:///workspace/nested/Component.vue",
    );
    const outerMatch = await manager.resolveForUri(
      "file:///workspace/other/Component.vue",
    );
    expect(innerMatch).toBe(inner);
    expect(outerMatch).toBe(outer);
  });

  it("resolveForUri falls back to an untrusted restricted session for a file outside any folder", async () => {
    const manager = fakeManager(true);
    await manager.addFolder("file:///workspace/a");
    const restricted = await manager.resolveForUri(
      "file:///elsewhere/Loose.vue",
    );
    expect(restricted.workspaceTrusted).toBe(false);
    expect(restricted.folderRoot).toBe("/elsewhere");
  });

  it("resolveForUri reuses the same restricted session for files sharing a directory", async () => {
    const manager = fakeManager();
    const first = await manager.resolveForUri("file:///elsewhere/A.vue");
    const second = await manager.resolveForUri("file:///elsewhere/B.vue");
    expect(first).toBe(second);
  });

  it("resolveForUri creates separate restricted sessions for different directories", async () => {
    const manager = fakeManager();
    const first = await manager.resolveForUri("file:///elsewhere/one/A.vue");
    const second = await manager.resolveForUri("file:///elsewhere/two/A.vue");
    expect(first).not.toBe(second);
  });

  it("reconfigureFolders re-resolves settings for every real folder but never touches restricted sessions", async () => {
    const manager = fakeManager();
    await manager.addFolder("file:///workspace/a");
    await manager.resolveForUri("file:///elsewhere/A.vue");
    const reconfigured = await manager.reconfigureFolders();
    expect(reconfigured).toHaveLength(1);
    expect(reconfigured[0]!.folderRoot).toBe("/workspace/a");
  });

  it("disposeAll disposes every session, folders and restricted alike, and clears them", async () => {
    const manager = fakeManager();
    await manager.addFolder("file:///workspace/a");
    await manager.resolveForUri("file:///elsewhere/A.vue");
    expect(manager.sessions()).toHaveLength(2);
    await manager.disposeAll();
    expect(manager.sessions()).toHaveLength(0);
  });
});
