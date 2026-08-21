export { createWorkspaceAnalyzer } from "./workspace-analyzer.js";
// Re-exported so hosts (language-server, cli) can construct/type a
// TypeAnalysisContext (ADR-0002; core.md §2) without a direct dependency on
// `vue-html-bridge` — the monorepo dependency graph keeps that edge to
// analyzer alone (monorepo.md §4.1).
export { createTypeAnalysisContext } from "vue-html-bridge";
export type {
  SourceRange,
  TypeAnalysisContext,
  TypeAnalysisFs,
} from "vue-html-bridge";
export type {
  AnalysisResult,
  AnalysisTiming,
  AnalyzeRequest,
  AnalyzerConfigWatchTarget,
  AnalyzerLogger,
  ConfiguredAdapter,
  CreateWorkspaceAnalyzerOptions,
  DiagnosticEvidence,
  ReconfigureOptions,
  SourceDiagnostic,
  SourceDiagnosticOrigin,
  SourceRelatedInformation,
  VariantSummary,
  WorkspaceAnalyzer,
} from "./types.js";
