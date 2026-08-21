import { PACKAGE_NAME as VALIDATOR_API_PACKAGE_NAME } from "@vue-html-bridge/validator-api";

export const PACKAGE_NAME = "@vue-html-bridge/adapter-markuplint";

export const dependsOn = [VALIDATOR_API_PACKAGE_NAME] as const;
