/**
 * 错误码与统一错误形状（DESIGN.md §5）。
 *
 * 服务端内部统一抛 `HttpError`，由 server.ts 的错误中间件转成
 * `{ error, message }`；SSE 路由复用同一个形状发 `error` 事件。
 */
export const ErrorCode = {
  inputTooLong: 'INPUT_TOO_LONG',
  invalidRequest: 'INVALID_REQUEST',
  collectionNotFound: 'COLLECTION_NOT_FOUND',
  entryNotFound: 'ENTRY_NOT_FOUND',
  translationInFlight: 'TRANSLATION_IN_FLIGHT',
  lmstudioUnavailable: 'LMSTUDIO_UNAVAILABLE',
  invalidJson: 'INVALID_JSON',
  notFound: 'NOT_FOUND',
  internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;

  constructor(status: number, code: ErrorCodeValue, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(code: ErrorCodeValue, message: string): HttpError {
  return new HttpError(400, code, message);
}

export function notFound(code: ErrorCodeValue, message: string): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(code: ErrorCodeValue, message: string): HttpError {
  return new HttpError(409, code, message);
}
