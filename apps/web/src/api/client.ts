/**
 * REST 封装：统一解析 `{ error, message }` 错误体并抛出 `ApiError`（DESIGN.md §5）。
 */

/** 后端统一错误码（DESIGN.md §5.3 / §6.5）；未知码按字符串保留。 */
export type ApiErrorCode =
  | 'INPUT_TOO_LONG'
  | 'INVALID_REQUEST'
  | 'COLLECTION_NOT_FOUND'
  | 'TRANSLATION_IN_FLIGHT'
  | 'LMSTUDIO_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** 一次请求的失败结果：HTTP 错误、网络错误或响应不可解析。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** 后端不可达（网络层失败）时为 true；服务关闭后前端会观察到这种错误。 */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把任意响应体转成记录；空体或非 JSON 体返回 undefined，交给调用方兜底。 */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** 从响应体里提取 `{ error, message }`；缺失时用 HTTP 状态兜底。 */
export function toApiError(status: number, body: unknown): ApiError {
  if (isRecord(body)) {
    const code = typeof body.error === 'string' && body.error !== '' ? body.error : 'INTERNAL_ERROR';
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : `请求失败（HTTP ${status}）`;
    return new ApiError(code, message, status);
  }
  return new ApiError('INTERNAL_ERROR', `请求失败（HTTP ${status}）`, status);
}

/** 供 UI 兜底显示：把任意抛出物转成中文可读文本。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return '发生未知错误';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** 发一次 JSON 请求；非 2xx 一律抛 `ApiError`。 */
export async function requestJson(path: string, options: RequestOptions = {}): Promise<unknown> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json' },
  };
  if (options.body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) {
    init.signal = options.signal;
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError('NETWORK_ERROR', '无法连接后端服务，可能已关闭', 0);
  }

  const body = response.status === 204 ? undefined : await readJsonBody(response);
  if (!response.ok) {
    throw toApiError(response.status, body);
  }
  return body;
}
