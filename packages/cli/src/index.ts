import { PACKAGE_NAME as ANALYZER_PACKAGE_NAME } from "@vue-html-bridge/analyzer";
import { PACKAGE_NAME as ADAPTER_MARKUPLINT_PACKAGE_NAME } from "@vue-html-bridge/adapter-markuplint";
import { PACKAGE_NAME as VALIDATOR_API_PACKAGE_NAME } from "@vue-html-bridge/validator-api";
import { PACKAGE_NAME as SETTINGS_PACKAGE_NAME } from "@vue-html-bridge/settings";

export const PACKAGE_NAME = "@vue-html-bridge/cli";

export const dependsOn = [
  ANALYZER_PACKAGE_NAME,
  ADAPTER_MARKUPLINT_PACKAGE_NAME,
  VALIDATOR_API_PACKAGE_NAME,
  SETTINGS_PACKAGE_NAME,
] as const;
