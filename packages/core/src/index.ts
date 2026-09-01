export const PACKAGE_NAME = "vue-html-bridge";

export {
  ATTRIBUTE_NAME_PATTERN,
  RESERVED_DIRECTIVE_NAMES,
  VALUE_PATH_PATTERN,
  createTypeAnalysisContext,
  generateVariants,
} from "./generate.js";
export { findSourceOrigins } from "./mapping.js";
export type {
  CoreDiagnostic,
  CustomDirectiveMapping,
  DecisionAssignment,
  GenerateOptions,
  GenerateRequest,
  GenerateResult,
  GeneratedRange,
  GeneratedValueProvenance,
  GenerationStats,
  HtmlVariant,
  JsonValue,
  MappingEntry,
  OffsetRange,
  SourceOrigin,
  SourceRange,
  TypeAnalysisContext,
  TypeAnalysisFs,
} from "./types.js";
