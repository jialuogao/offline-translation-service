/**
 * 翻译 SSE 客户端（DESIGN.md §5.3 / §9.3）。
 *
 * `EventSource` 不支持 POST，因此用 fetch + ReadableStream 手工解析字节流：
 * 按行缓冲、兼容 CRLF、忽略 `:` 注释行、多行 `data:` 以 `\n` 连接。
 */

import {
  SSE_EVENT_DELTA,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  type DoneEvent,
  type TranslateRequest,
} from '@ots/contracts';
import { ApiError, readJsonBody, toApiError } from './client';

export type TranslateStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; done: DoneEvent };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把一条完整的 SSE 记录转成事件；心跳/注释/未知事件返回 null。 */
function toStreamEvent(eventName: string, data: string): TranslateStreamEvent | null {
  if (data === '') {
    return null;
  }
  const payload = parseJson(data);
  if (eventName === SSE_EVENT_DELTA) {
    if (isRecord(payload) && typeof payload.text === 'string') {
      return { type: 'delta', text: payload.text };
    }
    throw new ApiError('INTERNAL_ERROR', '服务端返回了无法解析的流式数据', 200);
  }
  if (eventName === SSE_EVENT_DONE) {
    if (
      isRecord(payload) &&
      typeof payload.entry_id === 'string' &&
      typeof payload.target_text === 'string'
    ) {
      const modelId = payload.model_id;
      return {
        type: 'done',
        done: {
          entry_id: payload.entry_id,
          target_text: payload.target_text,
          model_id: typeof modelId === 'string' ? modelId : null,
        },
      };
    }
    throw new ApiError('INTERNAL_ERROR', '服务端返回了无法解析的完成事件', 200);
  }
  if (eventName === SSE_EVENT_ERROR) {
    throw toApiError(200, payload);
  }
  return null;
}

/**
 * 发起流式翻译并逐条产出事件。
 *
 * - 非 2xx 响应是普通 JSON 错误体（如 400 INPUT_TOO_LONG / 409 TRANSLATION_IN_FLIGHT），抛 `ApiError`。
 * - SSE 流中出现 `error` 事件时同样抛 `ApiError`。
 * - 流意外结束时抛 `ApiError`，避免 UI 停在"翻译中"。
 */
export async function* streamTranslation(
  body: TranslateRequest,
  signal: AbortSignal,
): AsyncGenerator<TranslateStreamEvent, void, void> {
  const response = await fetch('/api/translate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw toApiError(response.status, await readJsonBody(response));
  }
  if (!response.body) {
    throw new ApiError('INTERNAL_ERROR', '浏览器不支持流式响应', 200);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let finished = false;

  // 处理一行并返回一条已终结的事件记录（空行才终结记录）。
  const consumeLine = (rawLine: string): TranslateStreamEvent | null => {
    if (rawLine !== '') {
      if (!rawLine.startsWith(':')) {
        const colonIndex = rawLine.indexOf(':');
        const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
        let value = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        if (field === 'event') {
          eventName = value;
        } else if (field === 'data') {
          dataLines.push(value);
        }
      }
      return null;
    }
    const event = toStreamEvent(eventName, dataLines.join('\n'));
    eventName = '';
    dataLines = [];
    return event;
  };

  const emit = (event: TranslateStreamEvent | null): TranslateStreamEvent | null => {
    if (event && event.type === 'done') {
      finished = true;
    }
    return event;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const event = emit(consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine));
        if (event) {
          yield event;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }

    // 流结束时可能缺少尾随空行：把缓冲区残余行与未完记录都收尾。
    if (buffer !== '') {
      const rawLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      const event = emit(consumeLine(rawLine));
      if (event) {
        yield event;
      }
    }
    const tail = emit(consumeLine(''));
    if (tail) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }

  if (!finished) {
    throw new ApiError('STREAM_INTERRUPTED', '翻译流意外中断，未保存任何内容', 200);
  }
}
