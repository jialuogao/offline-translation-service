import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenOnSafePort } from '../helpers/paths.js';

/**
 * Mock LM Studio（DESIGN.md §8）。
 *
 * 实现 LM Studio 的 OpenAI 兼容子集，供后端回归测试使用：不依赖真实实例、模型
 * 或网络。默认译文是**确定性**的，便于断言：
 *   - `X-Mock-Source-Lang: zh` → 输出 `EN[<原文>]`
 *   - `X-Mock-Source-Lang: en` → 输出 `ZH[<原文>]`
 * 缺少该头时按 system prompt 里的 `from <lang> to` 兜底推断（§8.2）。
 *
 * 故障注入（query 或同名请求头）：
 *   - `mock_fail=lmstudio_down`        → 503
 *   - `mock_fail=mid_stream_cut`       → 发出首个 chunk 后强制断开
 *   - `mock_fail=hang`                 → 悬挂不结束，直到客户端断开（测 abort）
 *   - `mock_chunk_size=<n>`            → 译文分片大小
 *   - `mock_delay_ms=<n>`              → 每个分片之间的延迟
 */

export interface MockServerOptions {
  modelIds?: string[];
  /** 分片大小，默认 5 个字符。 */
  chunkSize?: number;
  /** 每个分片之间的延迟，默认 0。 */
  chunkDelayMs?: number;
  /** 收到请求的日志回调。 */
  onRequest?: (info: { method: string; url: string }) => void;
  /** SSE 流被客户端断开时触发（用于断言 abort 行为）。 */
  onStreamAborted?: (info: { path: string }) => void;
}

export interface MockServer {
  /** 监听地址，形如 `http://127.0.0.1:PORT`，可直接作为 `LMSTUDIO_BASE_URL`。 */
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

interface ChatRequestBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: string }>;
}

const DEFAULT_MODEL_IDS = ['mock-hy-mt2-30b-a3b'];

export function createMockServer(options: MockServerOptions = {}): http.Server {
  const modelIds = options.modelIds ?? DEFAULT_MODEL_IDS;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    options.onRequest?.({ method: req.method ?? 'GET', url: req.url ?? '/' });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, object: 'model' })) }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      void handleChatCompletion(req, res, url, options);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
}

async function handleChatCompletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: MockServerOptions,
): Promise<void> {
  const rawBody = await readBody(req);
  let body: ChatRequestBody = {};
  try {
    body = rawBody === '' ? {} : (JSON.parse(rawBody) as ChatRequestBody);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json body' } }));
    return;
  }

  const failure = param(req, url, 'mock_fail');
  if (failure === 'lmstudio_down') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock: model server unavailable' } }));
    return;
  }

  const sourceLang = detectSourceLang(req, body);
  const targetLang = sourceLang === 'zh' ? 'en' : 'zh';
  const sourceText = lastUserContent(body);
  const translation = `${targetLang.toUpperCase()}[${sourceText}]`;

  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model ?? DEFAULT_MODEL_IDS[0],
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: translation },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }

  const chunkSize = positiveInt(param(req, url, 'mock_chunk_size'), options.chunkSize ?? 5);
  const delayMs = positiveInt(param(req, url, 'mock_delay_ms'), options.chunkDelayMs ?? 0);
  const chunks = splitEvery(translation, chunkSize);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let aborted = false;
  const onClose = (): void => {
    aborted = true;
    options.onStreamAborted?.({ path: url.pathname });
  };
  res.on('close', onClose);

  const writeChunk = (content: string): void => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  };

  if (failure === 'hang') {
    // 保持连接直到客户端断开（用于验证后端 abort 后不落库）。周期性发送 SSE
    // 注释行作为心跳，让客户端的读取循环真实处于等待状态。
    const keepAlive = setInterval(() => {
      if (aborted) return;
      res.write(': keep-alive\n\n');
    }, 20);
    res.on('close', () => clearInterval(keepAlive));
    return;
  }

  if (failure === 'mid_stream_cut') {
    writeChunk(chunks[0] ?? '');
    // 模拟上游中途断流：不发 [DONE]，直接摧毁 socket。
    res.socket?.destroy();
    res.off('close', onClose);
    return;
  }

  for (const chunk of chunks) {
    if (aborted) {
      res.off('close', onClose);
      return;
    }
    writeChunk(chunk);
    if (delayMs > 0) await sleep(delayMs);
  }
  res.write('data: [DONE]\n\n');
  res.off('close', onClose);
  res.end();
}

/** 启动 Mock 并返回可用地址；默认在安全端口区间内挑一个空闲端口。 */
export async function startMockServer(
  options: MockServerOptions & { port?: number } = {},
): Promise<MockServer> {
  const server = createMockServer(options);
  const requested = options.port;
  // listen(0) 可能拿到 fetch 拒绝的端口（bad port），因此显式挑安全端口。
  const port = await listenOnSafePort(
    (candidate) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      }),
    requested,
  );
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

/** §8.2 的确定性映射，供测试直接引用期望值。 */
export function expectedTranslation(sourceLang: 'zh' | 'en', sourceText: string): string {
  return `${sourceLang === 'zh' ? 'EN' : 'ZH'}[${sourceText}]`;
}

function detectSourceLang(req: http.IncomingMessage, body: ChatRequestBody): 'zh' | 'en' {
  const header = headerValue(req, 'x-mock-source-lang');
  if (header === 'zh' || header === 'en') return header;

  const system = body.messages?.find((message) => message.role === 'system')?.content ?? '';
  const match = /from\s+(Chinese|English)\s+to/i.exec(system);
  if (match?.[1]?.toLowerCase() === 'chinese') return 'zh';
  if (match?.[1]?.toLowerCase() === 'english') return 'en';
  return 'en';
}

function lastUserContent(body: ChatRequestBody): string {
  const users = (body.messages ?? []).filter((message) => message.role === 'user');
  return users[users.length - 1]?.content ?? '';
}

function param(req: http.IncomingMessage, url: URL, name: string): string | null {
  const fromHeader = headerValue(req, name.replace(/_/g, '-'));
  if (fromHeader !== null) return fromHeader;
  return url.searchParams.get(name);
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === 'string' && value !== '') return value;
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null;
  return null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** 按字符切分（不按字节），保证多字节字符不会被拆断。 */
export function splitEvery(value: string, size: number): string[] {
  if (value === '') return [];
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += safeSize) {
    chunks.push(value.slice(index, index + safeSize));
  }
  return chunks;
}

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
