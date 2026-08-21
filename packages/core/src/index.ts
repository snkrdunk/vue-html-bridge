export const PACKAGE_NAME = "vue-html-bridge";

export { createTypeAnalysisContext, generateVariants } from "./generate.js";
export { findSourceOrigins } from "./mapping.js";
export type {
  CoreDiagnostic,
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
