import { PACKAGE_NAME as CORE_PACKAGE_NAME } from "vue-html-bridge";
import { PACKAGE_NAME as VALIDATOR_API_PACKAGE_NAME } from "@vue-html-bridge/validator-api";

export const PACKAGE_NAME = "@vue-html-bridge/analyzer";

export const dependsOn = [
  CORE_PACKAGE_NAME,
  VALIDATOR_API_PACKAGE_NAME,
] as const;
