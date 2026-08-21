import type {
  DecisionAssignment,
  GenerateOptions,
  SourceRange,
  TypeAnalysisContext,
} from "vue-html-bridge";
import type {
  AdapterLogger,
  ConfigWatchTarget,
  GeneratedRange,
  HtmlValidatorAdapter,
} from "@vue-html-bridge/validator-api";

export type AnalyzerLogger = AdapterLogger;

export interface ConfiguredAdapter<TSettings = unknown> {
  adapter: HtmlValidatorAdapter<TSettings>;
  settings: TSettings;
  enabled: boolean;
}

export interface CreateWorkspaceAnalyzerOptions {
  workspaceRoot: string;
  adapters: readonly ConfiguredAdapter[];
  generateOptions?: GenerateOptions;
  typeContext?: TypeAnalysisContext;
  maxConcurrency?: number;
  logger?: AnalyzerLogger;
}

export interface ReconfigureOptions {
  adapters?: readonly ConfiguredAdapter[];
  generateOptions?: GenerateOptions;
  maxConcurrency?: number;
  invalidateAdapters?: readonly string[];
}

export interface AnalyzerConfigWatchTarget extends ConfigWatchTarget {
  adapterId: string;
}

export interface WorkspaceAnalyzer {
  analyze(request: AnalyzeRequest): Promise<AnalysisResult>;
  reconfigure(options: ReconfigureOptions): Promise<void>;
  getConfigWatchTargets(): readonly AnalyzerConfigWatchTarget[];
  dispose(): Promise<void>;
}

export interface AnalyzeRequest {
  uri: string;
  filename: string;
  source: string;
  documentVersion?: number;
  signal: AbortSignal;
}

export interface AnalysisResult {
  uri: string;
  documentVersion?: number;
  diagnostics: readonly SourceDiagnostic[];
  variantSummary: VariantSummary;
  timing: AnalysisTiming;
}

export interface VariantSummary {
  candidateCount: number;
  emittedCount: number;
  uniqueHtmlCount: number;
  warningThresholdExceeded: boolean;
}

export interface AnalysisTiming {
  durationMs: number;
}

export type SourceDiagnosticOrigin = "core" | "validator" | "adapter";

export interface SourceDiagnostic {
  id: string;
  origin: SourceDiagnosticOrigin;
  sourceRange: SourceRange;
  relatedInformation: readonly SourceRelatedInformation[];
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code: string;
  adapterId?: string;
  codeDescriptionHref?: string;
  evidence: DiagnosticEvidence;
}

export interface SourceRelatedInformation {
  sourceRange: SourceRange;
  message: string;
}

export interface DiagnosticEvidence {
  variantCount: number;
  variantIds: readonly string[];
  exampleDecisions: readonly DecisionAssignment[];
  generatedExample?: {
    virtualFilename: string;
    range?: GeneratedRange;
  };
  truncated: boolean;
  originalValidatorMessage?: string;
  /** Set when a fallback source position was used (analyzer.md §6.2). */
  mappingFallback?: boolean;
}
