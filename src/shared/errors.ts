import { type ErrorCode, ErrorCodeSchema, type ErrorResponse } from './protocol';

/** An error carrying a protocol error code, so it can cross a messaging boundary intact. */
export class CodedError extends Error {
  override name = 'CodedError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function toErrorResponse(err: unknown): ErrorResponse {
  const code =
    err instanceof Error && 'code' in err && ErrorCodeSchema.safeParse(err.code).success
      ? (err.code as ErrorCode)
      : 'INTERNAL';
  return { ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } };
}
