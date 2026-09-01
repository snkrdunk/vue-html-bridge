import type {
  DecisionAssignment,
  GenerateOptions,
  MappingEntry,
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
  /**
   * Opt-in: when true, `analyze()` additionally populates
   * `AnalysisResult.variantArtifacts` (plan.md T2/Q5, ADR-0011). Has no effect
   * on generation/validation caching (analyzer.md §10.1/§10.2) — the cached
   * `GenerateResult` already retains `.variants` regardless of this flag;
   * this option only gates whether `analyze()` additionally returns it.
   */
  collectVariantArtifacts?: boolean;
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
  /**
   * Present only when `collectVariantArtifacts` was set. One entry per
   * unique generated HTML (hash-grouped, analyzer.md §5.2), independent of
   * adapters/diagnostics — populated even for a clean run with zero
   * diagnostics, since the point is showing generated HTML, not
   * diagnostic-linked HTML (plan.md T2).
   */
  variantArtifacts?: readonly VariantArtifact[];
}

/** One per unique generated HTML within one `analyze()` call (plan.md Q1/Q5). */
export interface VariantArtifact {
  htmlHash: string;
  virtualFilename: string;
  html: string;
  /** Every variant whose HTML collapsed into this group, with its own decisions. */
  variants: readonly VariantArtifactMember[];
  /** The representative variant's mapping entries (same precedent as the
   * diagnostic-occurrence path's `representative?.map`, workspace-analyzer.ts). */
  map: readonly MappingEntry[];
}

export interface VariantArtifactMember {
  variantId: string;
  decisions: readonly DecisionAssignment[];
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
  /**
   * Set when this diagnostic was rewritten from one or more raw validator
   * diagnostics via provenance (analyzer.md §7). Plural because §8.1/§7.1
   * merge every raw diagnostic that rewrites to the same bridge diagnostic
   * (e.g. the same sentinel hit by several variants) into one entry, keeping
   * each original message as evidence — ordered by ruleId/message, truncated
   * at 5, same as `variantIds`.
   */
  originalValidatorMessages?: readonly string[];
  /** Set when a fallback source position was used (analyzer.md §6.2). */
  mappingFallback?: boolean;
}
