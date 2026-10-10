/**
 * Provider failures in plain words. The SDKs' typed errors and status codes are
 * classified here, once, for every surface that shows a failed request; the
 * provider's own text stays on the error as `raw` for Activity and diagnostics.
 */
export type ProviderName = "anthropic" | "openai";

export type ProviderFailureKind =
  | "key"
  | "permission"
  | "billing"
  | "rate-limit"
  | "unavailable"
  | "too-large"
  | "model"
  | "offline"
  | "timeout"
  | "general";

const PROVIDER_LABEL: Record<ProviderName, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/** What the SDK reports about a failed request: its status, error code and error type. */
export interface ProviderFailureFields {
  status?: number | undefined;
  code?: string | null | undefined;
  type?: string | null | undefined;
}

const KIND_BY_CODE: Record<string, ProviderFailureKind> = {
  insufficient_quota: "billing",
  billing_hard_limit_reached: "billing",
  billing_error: "billing",
  context_length_exceeded: "too-large",
  request_too_large: "too-large",
  model_not_found: "model",
  not_found_error: "model",
  invalid_api_key: "key",
  authentication_error: "key",
  permission_error: "permission",
  rate_limit_error: "rate-limit",
  rate_limit_exceeded: "rate-limit",
  overloaded_error: "unavailable",
  api_error: "unavailable",
  server_error: "unavailable",
};

/** Classify by error code or type first, since OpenAI reports quota as a 429, then by status. */
export function classifyProviderFailure(fields: ProviderFailureFields): ProviderFailureKind {
  for (const name of [fields.code, fields.type]) {
    const kind = name && Object.hasOwn(KIND_BY_CODE, name) ? KIND_BY_CODE[name] : undefined;
    if (kind) return kind;
  }
  const { status } = fields;
  if (status === undefined) return "general";
  if (status === 402) return "billing";
  if (status === 413) return "too-large";
  if (status === 404) return "model";
  if (status === 401) return "key";
  if (status === 403) return "permission";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "unavailable";
  return "general";
}

export function providerFailureMessage(kind: ProviderFailureKind, provider: ProviderName): string {
  const name = PROVIDER_LABEL[provider];
  switch (kind) {
    case "key":
      return `${name} did not accept your API key. Check it in AI settings.`;
    case "permission":
      return `Your ${name} key is not allowed to make this request. Check the key in AI settings.`;
    case "billing":
      return `Your ${name} account has no credit left or reached its billing limit. Add credit with ${name}, then try again.`;
    case "rate-limit":
      return `${name} is getting too many requests. Wait a minute, then try again.`;
    case "unavailable":
      return `${name} is busy or unavailable right now. Wait a few minutes, then try again.`;
    case "too-large":
      return "This conversation is too long for the model. Start a new conversation, then try again.";
    case "model":
      return `${name} does not offer this model to your key. Choose another model in AI settings.`;
    case "offline":
      return `Could not reach ${name}. Check your internet connection, then try again.`;
    case "timeout":
      return `${name} took too long to answer. Try again.`;
    case "general":
      return `${name} could not complete the request. Try again, and open Activity for details if it keeps failing.`;
  }
}

/** A failed provider request. `message` is for the player; `raw` is the provider's own text. */
export class ProviderRequestError extends Error {
  readonly kind: ProviderFailureKind;
  readonly provider: ProviderName;
  readonly status: number | undefined;
  readonly raw: string;
  constructor(
    kind: ProviderFailureKind,
    provider: ProviderName,
    raw: string,
    options?: { status?: number | undefined; cause?: unknown },
  ) {
    super(providerFailureMessage(kind, provider));
    this.name = "ProviderRequestError";
    this.kind = kind;
    this.provider = provider;
    this.status = options?.status;
    this.raw = raw;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** The error classes an SDK module exports. */
export interface SdkErrorClasses {
  APIError: abstract new (...args: never[]) => Error;
  APIConnectionError: abstract new (...args: never[]) => Error;
  APIConnectionTimeoutError: abstract new (...args: never[]) => Error;
  APIUserAbortError: abstract new (...args: never[]) => Error;
}

/**
 * Convert an SDK error to a ProviderRequestError. Anything else, including the user's Stop,
 * is returned unchanged.
 */
export function toProviderError(
  error: unknown,
  provider: ProviderName,
  sdk: SdkErrorClasses,
): unknown {
  if (error instanceof ProviderRequestError || error instanceof sdk.APIUserAbortError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  if (error instanceof sdk.APIConnectionTimeoutError)
    return new ProviderRequestError("timeout", provider, raw, { cause: error });
  if (error instanceof sdk.APIConnectionError)
    return new ProviderRequestError("offline", provider, raw, { cause: error });
  if (!(error instanceof sdk.APIError)) return error;
  const fields = error as unknown as ProviderFailureFields;
  return new ProviderRequestError(classifyProviderFailure(fields), provider, raw, {
    status: fields.status,
    cause: error,
  });
}

/** The text to keep for debugging: the provider's own words when it gave any. */
export function providerFailureDetail(cause: unknown): string {
  if (cause instanceof ProviderRequestError)
    return cause.status === undefined ? cause.raw : `${cause.raw} (status ${cause.status})`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** The kind for an OpenAI image failure, which the image provider already sorted by reason. */
export function openAiImageFailureKind(
  reason: string,
  status: number | undefined,
): ProviderFailureKind | undefined {
  switch (reason) {
    case "auth":
      return "key";
    case "model-access":
      return status === 403 ? "permission" : "model";
    case "quota":
      return "billing";
    case "rate-limit":
      return "rate-limit";
    case "timeout":
      return "timeout";
    case "transport":
      return status === undefined ? "offline" : "unavailable";
    default:
      return undefined;
  }
}
