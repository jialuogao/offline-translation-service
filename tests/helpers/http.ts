/**
 * HTTP 与 SSE 断言辅助：对接 DESIGN.md §5 的契约形状。
 */

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = unknown>(
  baseUrl: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeJson(text);
  return { status: response.status, body: parsed as T, headers: response.headers };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 读取完整 SSE 响应并解析为事件数组。 */
export async function readSse(
  baseUrl: string,
  pathname: string,
  body: unknown,
): Promise<{ status: number; contentType: string; events: SseEvent[]; text: string }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  return {
    status: response.status,
    contentType,
    text,
    events: contentType.includes('text/event-stream') ? parseSse(text) : [],
  };
}

export function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (dataLines.length === 0) continue;
    const data = safeJson(dataLines.join('\n'));
    events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  }
  return events;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 轮询直到条件成立或超时（用于异步落库/状态断言）。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时${options.label === undefined ? '' : `：${options.label}`}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
