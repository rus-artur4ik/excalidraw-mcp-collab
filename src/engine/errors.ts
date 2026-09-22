export type ToolErrorCode =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "conflict"
  | "invalid_args"
  | "too_large"
  | "unsupported_field"
  | "internal";

export type ToolErrorDetails = {
  field?: string;
  ids?: string[];
  hint?: string;
  [key: string]: unknown;
};

// A failure the agent can act on: `code` says what kind, `retryable` whether
// repeating the same call can succeed, `details.hint` what to do instead.
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;
  readonly details?: ToolErrorDetails;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSec?: number; details?: ToolErrorDetails } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = options.retryable ?? (code === "rate_limited" || code === "conflict");
    this.retryAfterSec = options.retryAfterSec;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterSec !== undefined
        ? {
            retryAfterSec: this.retryAfterSec,
            resetAt: new Date(Date.now() + this.retryAfterSec * 1000).toISOString(),
          }
        : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const invalidArgs = (message: string, details?: ToolErrorDetails): ToolError =>
  new ToolError("invalid_args", message, { retryable: false, details });

export const notFound = (message: string, ids?: string[]): ToolError =>
  new ToolError("not_found", message, { retryable: false, details: ids ? { ids } : undefined });
