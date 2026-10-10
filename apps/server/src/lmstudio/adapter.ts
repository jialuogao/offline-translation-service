/**
 * LM Studio OpenAI 兼容端点的唯一封装（DESIGN.md §3.2 / §7）。
 *
 * 其它模块不得直接访问 LM Studio HTTP API；测试时把 `baseUrl` 指向
 * `tests/mock-lmstudio`（DESIGN.md §8.1）即可全链路回归。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatStreamOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  /** 附加请求头；仅测试用（如 `X-Mock-Source-Lang`）。 */
  extraHeaders?: Record<string, string>;
  /** 附加 query；仅测试用（如 `mock_fail=lmstudio_down`）。 */
  query?: Record<string, string>;
}

export interface ChatStream {
  /** 实际生效的 model id（请求未指定时由服务端决定）。 */
  model: string | null;
  /** 译文增量；每个元素对应一个 OpenAI chunk 的 `choices[0].delta.content`。 */
  deltas: AsyncIterable<string>;
}

/** LM Studio 调用失败：映射为 §5.3 的 `error` 事件 / §6.5 的降级码。 */
export class LMStudioError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'LMStudioError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface LMStudioAdapterOptions {
  baseUrl: string;
  /** 探测/短请求超时（DESIGN.md §6.1：单次 2s）。 */
  probeTimeoutMs: number;
  /** 覆盖 model id（§11 `LMSTUDIO_MODEL`）；空则取首个。 */
  model?: string;
  /** 显式加载模型（§13 第 5 条）的允许耗时，默认 5 分钟。 */
  loadTimeoutMs?: number;
}

/** 单个模型的描述（§13 第 5 条：区分"已加载"与"仅可用"）。 */
export interface ModelInfo {
  id: string;
  state: 'loaded' | 'loading' | 'not-loaded' | 'unknown';
}

/** 优于 `/v1/models` 的元数据端点；Mock 未实现时自动降级。 */
const V0_MODELS_PATH = '/api/v0/models';
const LOAD_PATH = '/api/v1/models/load';

interface ModelListResponse {
  data?: Array<{ id?: unknown; state?: unknown }>;
}

export class LMStudioAdapter {
  private readonly baseUrl: string;
  private readonly probeTimeoutMs: number;
  private readonly configuredModel: string;
  private readonly loadTimeoutMs: number;

  constructor(options: LMStudioAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.probeTimeoutMs = options.probeTimeoutMs;
    this.configuredModel = options.model?.trim() ?? '';
    this.loadTimeoutMs = options.loadTimeoutMs ?? 300_000;
  }

  /** `GET /v1/models`，失败抛 `LMStudioError('LMSTUDIO_UNAVAILABLE')`。 */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const models = await this.describeModels(signal);
    return models.map((model) => model.id);
  }

  /**
   * 带 `state` 的模型信息：优先 `GET /api/v0/models`（LM Studio 0.3.6+，
   * 能区分 loaded / not-loaded），不可用时退回 `GET /v1/models`。
   */
  async describeModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const response = await this.request(V0_MODELS_PATH, {
        method: 'GET',
        signal,
        timeoutMs: this.probeTimeoutMs,
      });
      return parseModelList(await readJson(response));
    } catch {
      const response = await this.request('/v1/models', {
        method: 'GET',
        signal,
        timeoutMs: this.probeTimeoutMs,
      });
      return parseModelList(await readJson(response));
    }
  }

  /**
   * 显式加载模型（§13 第 5 条：`POST /api/v1/models/load`）。
   *
   * **重要（实测）**：LM Studio 的 load 端点每次成功调用都会**新建一个模型实例**
   * （`model`、`model:2`、`model:3`…），而不是复用已驻留的那个；这会把显存/内存吃干，
   * 之后连加载都会因资源不足失败。因此这里先查 `state`：只要目标模型（或其 `:N`
   * 实例）已经驻留，就直接返回 `true`，绝不重复加载。
   *
   * 模型冷加载可能远超单次探测超时，故使用独立的 `loadTimeoutMs`。加载失败不影响
   * 服务可用性（首次推理仍可能触发隐式加载），调用方据此降级即可。
   */
  async loadModel(modelId: string, signal?: AbortSignal): Promise<boolean> {
    const target = modelId.trim();
    if (target === '') return false;

    try {
      const models = await this.describeModels(signal);
      // state 未知（老版本端点只有 /v1/models）时不跳过：宁可按需加载一次。
      if (models.some((model) => model.state !== 'unknown') && isModelResident(models, target)) {
        return true;
      }
    } catch {
      // 查不到状态就继续尝试加载。
    }

    try {
      const response = await this.request(LOAD_PATH, {
        method: 'POST',
        signal,
        timeoutMs: this.loadTimeoutMs,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: target }),
      });
      const payload = (await readJson(response)) as { status?: unknown };
      return payload.status === 'loaded' || response.ok;
    } catch (error) {
      if (error instanceof LMStudioError) return false;
      throw error;
    }
  }

  /** 解析实际使用的 model：显式参数 > `LMSTUDIO_MODEL` > 列表首个（§7.1）。 */
  async resolveModel(explicit?: string, signal?: AbortSignal): Promise<string | null> {
    const requested = explicit?.trim() ?? '';
    if (requested !== '') return requested;
    if (this.configuredModel !== '') return this.configuredModel;
    const models = await this.listModels(signal);
    return models[0] ?? null;
  }

  /** 探测端点可达性（`GET /v1/models` 200 且 JSON 合法，§6.1）。 */
  async isReachable(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.listModels(signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 流式 `POST /v1/chat/completions`。
   *
   * 返回时 HTTP 状态已校验完毕，错误在 `await` 处抛出；中途断流由 `deltas`
   * 迭代时抛出，调用方据此发 SSE `error`（DESIGN.md §5.3 / §8.3）。
   */
  async chatCompletion(options: ChatStreamOptions): Promise<ChatStream> {
    const model = await this.resolveModel(options.model, options.signal);
    const url = this.buildUrl('/v1/chat/completions', options.query);
    const response = await this.request(url, {
      method: 'POST',
      signal: options.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(options.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: model ?? undefined,
        messages: options.messages,
        temperature: options.temperature ?? 0.3,
        stream: true,
      }),
    });

    const responseModel = response.headers.get('x-model-id')?.trim() ?? '';

    return {
      model: responseModel === '' ? model : responseModel,
      deltas: this.readDeltas(response, options.signal),
    };
  }

  /**
   * 逐块解析 OpenAI SSE，产出 `choices[0].delta.content`（DESIGN.md §7.2）。
   *
   * 实测（Node 26 / undici）：fetch 已经 resolve 之后，abort 不保证让
   * `body.getReader().read()` 立刻 reject。因此这里显式把 abort 与读取竞争，
   * 取消时主动 `cancel()` 底层流，保证 §9.4 的"客户端断开即取消上游"成立。
   */
  private async *readDeltas(
    response: Response,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, undefined> {
    if (response.body === null) {
      throw new LMStudioError('LMSTUDIO_UNAVAILABLE', 'LM Studio 未返回响应体');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    /** 把 "读下一块" 与 "abort" 竞争，取消时拒绝。 */
    const readWithAbort = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (signal === undefined) return reader.read();
      if (signal.aborted) return Promise.reject(abortError(signal));
      return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const onAbort = (): void => {
          cleanup();
          void reader.cancel().catch(() => undefined);
          reject(abortError(signal));
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then(
          (result) => {
            cleanup();
            resolve(result);
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
      });
    };

    try {
      for (;;) {
        const { done, value } = await readWithAbort();
        if (done) return;
        if (value === undefined) continue;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          const text = this.parseSseLine(line);
          if (text === DONE_SENTINEL) return;
          if (text !== null) yield text;
          newlineIndex = buffer.indexOf('\n');
        }
      }
    } catch (error) {
      // 主动取消（客户端断开）原样抛出，由调用方识别为 abort。
      if (isAbortError(error) || signal?.aborted === true) throw error;
      throw new LMStudioError('LMSTUDIO_UNAVAILABLE', 'LM Studio 流式响应中断', {
        cause: error,
      });
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  /** 解析一行 SSE；返回 `null` 表示无内容，返回 sentinel 表示 `[DONE]`。 */
  private parseSseLine(line: string): string | null | typeof DONE_SENTINEL {
    if (line === '' || line.startsWith(':')) return null;
    if (!line.startsWith('data:')) return null;
    const payload = line.slice('data:'.length).trim();
    if (payload === '') return null;
    if (payload === '[DONE]') return DONE_SENTINEL;
    let parsed: { choices?: Array<{ delta?: { content?: unknown } }> };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      // 单行非法 JSON 不致命：跳过，等待后续 chunk。
      return null;
    }
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === 'string' && content !== '' ? content : null;
  }

  /** 统一请求：注入超时、把网络层失败转成 `LMStudioError`。 */
  private async request(
    pathOrUrl: string,
    init: RequestInit & { timeoutMs?: number },
  ): Promise<Response> {
    const { timeoutMs, signal: callerSignal = null, ...rest } = init;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal !== null) {
      if (callerSignal.aborted) onAbort();
      else callerSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.buildUrl(pathOrUrl), { ...rest, signal: controller.signal });
    } catch (error) {
      if (callerSignal?.aborted === true) throw error;
      throw new LMStudioError('LMSTUDIO_UNAVAILABLE', '无法连接 LM Studio', { cause: error });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new LMStudioError(
        'LMSTUDIO_UNAVAILABLE',
        `LM Studio 返回 ${response.status}${detail === '' ? '' : `：${truncate(detail, 200)}`}`,
      );
    }
    return response;
  }

  private buildUrl(pathOrUrl: string, query?: Record<string, string>): string {
    const base = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    if (query === undefined || Object.keys(query).length === 0) return base;
    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }
}

const DONE_SENTINEL = Symbol('sse-done');

/** 把模型列表响应规范化为 `ModelInfo[]`；缺 `state` 或未知值时记为 unknown。 */
function parseModelList(payload: unknown): ModelInfo[] {
  const data = (payload as ModelListResponse | null)?.data;
  if (!Array.isArray(data)) {
    throw new LMStudioError('LMSTUDIO_UNAVAILABLE', 'LM Studio 模型列表格式异常');
  }
  const models: ModelInfo[] = [];
  for (const item of data) {
    const id = item?.id;
    if (typeof id !== 'string' || id === '') continue;
    const state =
      item.state === 'loaded' || item.state === 'loading' || item.state === 'not-loaded'
        ? item.state
        : ('unknown' as const);
    models.push({ id, state });
  }
  return models;
}

/**
 * 某个模型是否已经驻留内存。
 *
 * LM Studio 会把每个加载的实例列成 `model`、`model:2`、`model:3`…，且**只要还有
 * 一个实例驻留，就不应再对该模型调 load**（load 会新建实例，把显存/内存吃干）。
 * 因此这里检查全部同名实例，而不是只看第一个匹配项。
 */
export function isModelResident(models: ModelInfo[], modelId: string): boolean {
  const target = modelId.trim();
  if (target === '') return false;
  return models.some(
    (model) =>
      model.state === 'loaded' && (model.id === target || model.id.startsWith(`${target}:`)),
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new LMStudioError('LMSTUDIO_UNAVAILABLE', 'LM Studio 返回了非法 JSON', {
      cause: error,
    });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** 统一的取消错误：调用方通过 `isAbortError` 或 signal 状态识别。 */
function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : '请求已取消');
  error.name = 'AbortError';
  return error;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
