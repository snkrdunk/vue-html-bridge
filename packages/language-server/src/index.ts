// analyzer and adapter-markuplint are no longer Stage-A stubs (Phase 1 Steps
// 4-5) and have no PACKAGE_NAME export; this cross-import smoke test proves
// the real imports resolve instead. validator-api/settings are still Stage-A
// stubs.
import { createWorkspaceAnalyzer } from "@vue-html-bridge/analyzer";
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import { PACKAGE_NAME as VALIDATOR_API_PACKAGE_NAME } from "@vue-html-bridge/validator-api";
import { PACKAGE_NAME as SETTINGS_PACKAGE_NAME } from "@vue-html-bridge/settings";

export const PACKAGE_NAME = "@vue-html-bridge/language-server";

export const dependsOn = [
  typeof createWorkspaceAnalyzer === "function"
    ? "@vue-html-bridge/analyzer"
    : "missing",
  markuplintAdapter.id,
  VALIDATOR_API_PACKAGE_NAME,
  SETTINGS_PACKAGE_NAME,
] as const;
