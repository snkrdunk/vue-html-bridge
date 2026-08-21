export const PACKAGE_NAME = "@vue-html-bridge/validator-api";
export const VALIDATOR_API_VERSION = 1 as const;

export interface GeneratedRange {
  start: number;
  end: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type DiagnosticApplicability =
  "html-semantics" | "source-representation" | "document-context";

export interface AdapterCapabilities {
  execution: "in-process" | "subprocess" | "remote";
  supportsCancellation: boolean;
  supportsConfigFiles: boolean;
  fragmentHandling: "native" | "wrapped";
  maxConcurrentValidations: number;
  configFilePatterns?: readonly string[];
}

export interface AdapterLogger {
  debug(message: string, data?: Readonly<Record<string, JsonValue>>): void;
  info(message: string, data?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, data?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, data?: Readonly<Record<string, JsonValue>>): void;
}

export const nullLogger: AdapterLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

export interface AdapterSessionContext<TSettings = unknown> {
  workspaceRoot: string;
  settings: TSettings;
  logger: AdapterLogger;
}

export interface ConfigWatchTarget {
  absolutePath: string;
  kind: "config" | "dependency";
}

export interface ValidateHtmlRequest {
  html: string;
  documentKind: "fragment";
  sourceFilename: string;
  virtualFilename: string;
}

export interface GeneratedDiagnostic {
  ruleId?: string;
  severity: DiagnosticSeverity;
  message: string;
  range?: GeneratedRange;
  applicability?: DiagnosticApplicability;
  codeDescriptionHref?: string;
  fingerprint?: string;
  data?: Readonly<Record<string, JsonValue>>;
}

export interface AdapterFailure {
  code:
    | "configuration-error"
    | "validator-unavailable"
    | "execution-error"
    | "invalid-validator-result";
  message: string;
  recoverable: boolean;
  details?: Readonly<Record<string, JsonValue>>;
}

export interface ValidateHtmlResult {
  diagnostics: readonly GeneratedDiagnostic[];
  failures: readonly AdapterFailure[];
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ValidatorSession {
  validate(
    request: ValidateHtmlRequest,
    signal: AbortSignal,
  ): Promise<ValidateHtmlResult>;
  getConfigWatchTargets?(): readonly ConfigWatchTarget[];
  dispose(): Promise<void>;
}

export interface HtmlValidatorAdapter<TSettings = unknown> {
  readonly apiVersion: typeof VALIDATOR_API_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  createSession(
    context: AdapterSessionContext<TSettings>,
  ): Promise<ValidatorSession>;
}

export interface AdapterSessionFailure extends Error {
  name: "AdapterSessionFailure";
  failure: AdapterFailure;
}

export class AdapterSessionFailureError
  extends Error
  implements AdapterSessionFailure
{
  override readonly name = "AdapterSessionFailure" as const;

  constructor(
    public readonly failure: AdapterFailure,
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
  }
}

export function isAdapterSessionFailure(
  value: unknown,
): value is AdapterSessionFailure {
  if (!(value instanceof Error)) return false;
  const candidate = value as Partial<AdapterSessionFailure>;
  return (
    candidate.name === "AdapterSessionFailure" &&
    isAdapterFailure(candidate.failure)
  );
}

export function isAbortError(value: unknown): boolean {
  return (
    (value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

export type AdapterRuntimeCheck =
  | { ok: true; adapter: HtmlValidatorAdapter<unknown> }
  | {
      ok: false;
      kind: "invalid-shape" | "api-version-mismatch";
      message: string;
    };

export function checkHtmlValidatorAdapter(value: unknown): AdapterRuntimeCheck {
  if (!isRecord(value)) {
    return invalid("Adapter export must be an object.");
  }
  if (value.apiVersion !== VALIDATOR_API_VERSION) {
    return {
      ok: false,
      kind: "api-version-mismatch",
      message: `Expected validator apiVersion ${VALIDATOR_API_VERSION}, received ${String(value.apiVersion)}.`,
    };
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.displayName)) {
    return invalid("Adapter id and displayName must be non-empty strings.");
  }
  if (typeof value.createSession !== "function") {
    return invalid("Adapter createSession must be a function.");
  }
  if (!isCapabilities(value.capabilities)) {
    return invalid("Adapter capabilities are invalid.");
  }
  return {
    ok: true,
    adapter: value as unknown as HtmlValidatorAdapter<unknown>,
  };
}

export function isHtmlValidatorAdapter(
  value: unknown,
): value is HtmlValidatorAdapter<unknown> {
  return checkHtmlValidatorAdapter(value).ok;
}

export function isAdapterFailure(value: unknown): value is AdapterFailure {
  if (!isRecord(value)) return false;
  return (
    [
      "configuration-error",
      "validator-unavailable",
      "execution-error",
      "invalid-validator-result",
    ].includes(String(value.code)) &&
    typeof value.message === "string" &&
    typeof value.recoverable === "boolean" &&
    (value.details === undefined || isJsonRecord(value.details))
  );
}

export function isValidateHtmlResult(
  value: unknown,
): value is ValidateHtmlResult {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isGeneratedDiagnostic) &&
    Array.isArray(value.failures) &&
    value.failures.every(isAdapterFailure) &&
    (value.metadata === undefined || isJsonRecord(value.metadata))
  );
}

export function compareGeneratedDiagnostics(
  left: GeneratedDiagnostic,
  right: GeneratedDiagnostic,
): number {
  const leftStart = left.range?.start ?? Number.POSITIVE_INFINITY;
  const rightStart = right.range?.start ?? Number.POSITIVE_INFINITY;
  return (
    leftStart - rightStart ||
    (left.range?.end ?? Number.POSITIVE_INFINITY) -
      (right.range?.end ?? Number.POSITIVE_INFINITY) ||
    severityRank(left.severity) - severityRank(right.severity) ||
    (left.ruleId ?? "").localeCompare(right.ruleId ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function severityRank(severity: DiagnosticSeverity): number {
  return { error: 0, warning: 1, info: 2, hint: 3 }[severity];
}

function isGeneratedDiagnostic(value: unknown): value is GeneratedDiagnostic {
  if (!isRecord(value)) return false;
  const validRange =
    value.range === undefined ||
    (isRecord(value.range) &&
      Number.isInteger(value.range.start) &&
      Number.isInteger(value.range.end) &&
      Number(value.range.start) >= 0 &&
      Number(value.range.end) >= Number(value.range.start));
  return (
    ["error", "warning", "info", "hint"].includes(String(value.severity)) &&
    typeof value.message === "string" &&
    validRange &&
    (value.data === undefined || isJsonRecord(value.data))
  );
}

function isCapabilities(value: unknown): value is AdapterCapabilities {
  if (!isRecord(value)) return false;
  return (
    ["in-process", "subprocess", "remote"].includes(String(value.execution)) &&
    typeof value.supportsCancellation === "boolean" &&
    typeof value.supportsConfigFiles === "boolean" &&
    ["native", "wrapped"].includes(String(value.fragmentHandling)) &&
    Number.isInteger(value.maxConcurrentValidations) &&
    Number(value.maxConcurrentValidations) >= 1 &&
    (value.configFilePatterns === undefined ||
      (Array.isArray(value.configFilePatterns) &&
        value.configFilePatterns.every((item) => typeof item === "string")))
  );
}

function invalid(message: string): AdapterRuntimeCheck {
  return { ok: false, kind: "invalid-shape", message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}
