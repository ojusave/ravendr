/**
 * Typed error codes the whole app uses. Adding a new one here forces
 * every caller that discriminates on `code` to handle it.
 */
export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "AT_CAPACITY"
  | "UPSTREAM_VOICE"
  | "UPSTREAM_LLM"
  | "UPSTREAM_RESEARCH"
  | "UPSTREAM_WORKFLOW"
  | "DB"
  | "TIMEOUT"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.cause = opts.cause;
  }

  static from(err: unknown, fallback: ErrorCode = "INTERNAL"): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError(fallback, message, { cause: err });
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "AT_CAPACITY":
      return 503;
    case "TIMEOUT":
      return 504;
    case "UPSTREAM_VOICE":
    case "UPSTREAM_LLM":
    case "UPSTREAM_RESEARCH":
    case "UPSTREAM_WORKFLOW":
      return 502;
    case "DB":
    case "INTERNAL":
      return 500;
  }
}
