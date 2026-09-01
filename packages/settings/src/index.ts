export const PACKAGE_NAME = "@vue-html-bridge/settings";

export type {
  CustomDirectiveSettingInput,
  ResolvedCustomDirectiveSetting,
  ResolvedValidatorSetting,
  ResolvedVueHtmlBridgeSettings,
  SettingsIssue,
  ValidatorSettingInput,
  VueHtmlBridgeSettingsInput,
} from "./schema.js";

export { DEFAULT_SETTINGS } from "./defaults.js";

export {
  ATTRIBUTE_NAME_PATTERN,
  RESERVED_DIRECTIVE_NAMES,
  VALUE_PATH_PATTERN,
  resolveSettings,
} from "./resolve.js";

export {
  decomposeSettings,
  type AnalyzerOptions,
  type DecomposedSettings,
  type GenerateOptions,
  type HostSettings,
} from "./decompose.js";

export { SETTINGS_DECOMPOSITION_FIXTURE } from "./decomposition-fixture.js";

export {
  createNodeFileSystem,
  loadSettingsFile,
  loadWorkspaceSettingsFile,
  type SettingsFileResult,
  type SettingsFileSystem,
} from "./loader.js";

export {
  generateSettingsJsonSchema,
  serializeSettingsJsonSchema,
  type JsonSchemaValue,
} from "./json-schema.js";
