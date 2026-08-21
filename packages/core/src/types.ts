export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface OffsetRange {
  start: number;
  end: number;
}

export interface SourceRange extends OffsetRange {
  filename: string;
}

export type GeneratedRange = OffsetRange;

export interface TypeAnalysisFs {
  fileExists(filename: string): boolean;
  readFile(filename: string): string | undefined;
}

export interface TypeAnalysisContext {
  readonly fs: TypeAnalysisFs;
  readonly epoch: number;
  invalidate(filenames: readonly string[]): void;
}

export interface GenerateOptions {
  warnVariantCount?: number;
  customElements?: readonly string[];
}

export interface GenerateRequest {
  filename: string;
  source: string;
  options?: GenerateOptions;
  typeContext?: TypeAnalysisContext;
  signal?: AbortSignal;
}

export interface GenerateResult {
  variants: readonly HtmlVariant[];
  diagnostics: readonly CoreDiagnostic[];
  stats: GenerationStats;
  templateRange?: SourceRange;
}

export interface HtmlVariant {
  id: string;
  ordinal: number;
  html: string;
  decisions: readonly DecisionAssignment[];
  map: readonly MappingEntry[];
}

export interface DecisionAssignment {
  decisionId: string;
  displayName: string;
  value: JsonValue;
}

export type GeneratedValueProvenance =
  | { kind: "source-literal"; sourceRange: SourceRange }
  | {
      kind: "finite-domain";
      sourceRange: SourceRange;
      decisionId: string;
    }
  | {
      kind: "synthetic";
      sourceRange: SourceRange;
      transformation: "vue-event" | "v-model" | "text-placeholder";
    }
  | {
      kind: "sentinel";
      sourceRange: SourceRange;
      reason: "non-finite-type" | "unresolved-expression";
      originalType?: string;
    };

export interface MappingEntry {
  generated: GeneratedRange;
  source: SourceRange;
  kind: "element-name" | "attribute-name" | "attribute-value" | "text";
  provenance: GeneratedValueProvenance;
}

export interface SourceOrigin {
  entry: MappingEntry;
  overlap: number;
}

export interface CoreDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  sourceRange: SourceRange;
  relatedRanges?: readonly SourceRange[];
}

export interface GenerationStats {
  decisionCount: number;
  candidateCount: number;
  emittedCount: number;
  uniqueHtmlCount: number;
  durationMs: number;
  warningThresholdExceeded: boolean;
}
