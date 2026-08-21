import { PACKAGE_NAME as ANALYZER_PACKAGE_NAME } from "@vue-html-bridge/analyzer";
// adapter-markuplint is no longer a Stage-A stub (Phase 1 Step 4) and has no
// PACKAGE_NAME export; this cross-import smoke test uses its real adapter id
// instead. analyzer/validator-api/settings are still Stage-A stubs.
import { markuplintAdapter } from "@vue-html-bridge/adapter-markuplint";
import { PACKAGE_NAME as VALIDATOR_API_PACKAGE_NAME } from "@vue-html-bridge/validator-api";
import { PACKAGE_NAME as SETTINGS_PACKAGE_NAME } from "@vue-html-bridge/settings";

export const PACKAGE_NAME = "@vue-html-bridge/language-server";

export const dependsOn = [
  ANALYZER_PACKAGE_NAME,
  markuplintAdapter.id,
  VALIDATOR_API_PACKAGE_NAME,
  SETTINGS_PACKAGE_NAME,
] as const;
