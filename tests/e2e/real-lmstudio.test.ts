import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EntryPage } from '@ots/contracts';
import { E2E_BASE_URL, E2E_MODEL, activeCollectionId, assertRealLmStudioReady, chooseModelId, createE2EContext, type E2EContext } from './helper.js';
import { api } from '../helpers/http.js';

/**
 * 真实 LM Studio 端到端测试（中文 → 英文 / 英文 → 中文，真实流式输出）。
 *
 * 单独执行，绝不与常规测试同跑：
 *
 * ```powershell
 * pnpm test:e2e
 * ```
 *
 * 前置条件（不满足就直接失败，并给出中文提示，不会静默跳过）：
 * - LM Studio 已运行且本地服务器可用（默认 `http://127.0.0.1:1234`，可用
 *   `LMSTUDIO_BASE_URL` 覆盖）；
 * - 端点至少有一个模型；`LMSTUDIO_MODEL` 可指定。
 *
 * 断言分成两类：
 * - **结构断言**（严格）：SSE 帧格式、delta 拼接等于 done.target_text、`done.model_id`
 *   等于实际使用的模型、落库内容与 `done` 一致、合集计数增长、`INPUT_TOO_LONG` 不触发推理；
 * - **质量断言**（宽松）：只验证"确实发生了翻译"——译文非空、无替换字符、与原文不同，
 *   并且输出落在目标语言上（脚本占比）。绝不逐字比对译文。
 */

const ZH_SOURCE = '本机离线翻译服务已经跑通，翻译历史按合集组织，支持流式输出。';
const EN_SOURCE =
  'The offline translation service now streams results from a locally hosted model.';

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/gu;
const LATIN = /[A-Za-z]/g;

function count(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
}

/** 目标语言占比，用来粗判方向是否生效。 */
function cjkRatio(text: string): number {
  return text.length === 0 ? 0 : count(text, CJK) / text.length;
}

function latinRatio(text: string): number {
  return text.length === 0 ? 0 : count(text, LATIN) / text.length;
}

let ctx: E2EContext;
let collectionId: string;
let modelId: string;
let models: Array<{ id: string; state: string }>;
let loadedModel: string | undefined;

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** 逐块读取真实 SSE 响应，同时记录首块延迟与 delta 数量。 */
async function streamTranslation(
  baseUrl: string,
  body: { collection_id: string; source_lang: 'zh' | 'en'; target_lang: 'zh' | 'en'; source_text: string },
): Promise<{ status: number; contentType: string; frames: SseFrame[]; deltas: string[]; firstDeltaMs: number | null; totalMs: number }> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/translate/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const frames: SseFrame[] = [];
  const deltas: string[] = [];
  let firstDeltaMs: number | null = null;

  if (response.body !== null) {
    const decoder = new TextDecoder();
    let buffer = '';
    const handleblock = (block: string): void => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event === undefined || data === undefined) return;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      frames.push({ event, data: parsed });
      if (event === 'delta') {
        firstDeltaMs ??= Date.now() - startedAt;
        deltas.push(String(parsed.text ?? ''));
      }
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        handleblock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim() !== '') handleblock(buffer);
  }

  return {
    status: response.status,
    contentType,
    frames,
    deltas,
    firstDeltaMs,
    totalMs: Date.now() - startedAt,
  };
}

function entryPage(baseUrl: string, id: string): Promise<EntryPage> {
  return api<EntryPage>(baseUrl, 'GET', `/api/collections/${id}/entries`).then((r) => r.body);
}

beforeAll(async () => {
  const ready = await assertRealLmStudioReady();
  models = ready.models;
  loadedModel = ready.loaded;

  ctx = await createE2EContext();
  const available = await ctx.adapter.listModels();
  modelId = chooseModelId(models, available) as string;
  collectionId = await activeCollectionId(ctx.baseUrl);

  // 真实模型冷加载可能很久，给一次预热机会（与生产启动路径一致，§13 第 5 条）。
  // 模型已驻留时这里必须是"跳过"：LM Studio 每次成功 load 都会新建实例。
  const warmup = await ctx.processManager.warmup(E2E_MODEL);
  const status = await api<{ running: boolean; startedByUs: boolean; modelLoaded?: string }>(
    ctx.baseUrl,
    'GET',
    '/api/lmstudio/status',
  );

  console.log(
    [
      '',
      '=== E2E：真实 LM Studio ===',
      `端点            : ${E2E_BASE_URL}`,
      `模型总数        : ${models.length}`,
      `本次使用模型    : ${modelId}`,
      `端点报告已加载  : ${loadedModel ?? '（无）'}`,
      `状态接口        : running=${String(status.body.running)} startedByUs=${String(status.body.startedByUs)} modelLoaded=${status.body.modelLoaded ?? '-'}`,
      `预热            : attempted=${String(warmup.attempted)} alreadyResident=${String(warmup.alreadyResident)} model=${warmup.model ?? '-'} ok=${String(warmup.ok)}`,
      '==========================',
      '',
    ].join('\n'),
  );
}, 1_800_000);

afterAll(async () => {
  await ctx?.close();
});

describe('环境前置条件', () => {
  it('端点可达，且本次要用的模型在 /v1/models 中', () => {
    expect(modelId).toBeTruthy();
    expect(models.length).toBeGreaterThan(0);
    expect(ctx.processManager.status().startedByUs).toBe(false);
  });

  it('§13-5 状态接口能报告已加载模型（用于决定是否需要预热）', async () => {
    const status = await api<{ running: boolean; modelLoaded?: string }>(
      ctx.baseUrl,
      'GET',
      '/api/lmstudio/status',
    );
    expect(status.body.running).toBe(true);
    // 至少要报告一个模型；在已加载模型的机器上应与之一致。
    expect(status.body.modelLoaded).toBeTruthy();
    if (loadedModel !== undefined) {
      expect(status.body.modelLoaded).toBe(loadedModel);
    }
  });
});

describe('§13-5 预热不会重复新建实例（本机实测缺陷的回归）', () => {
  it('模型已驻留后再次预热必须是 no-op，且模型确实是 loaded', async () => {
    // 到这里已经翻译过若干次，模型必然已驻留（无论开始时是否已加载）。
    const before = await ctx.adapter.describeModels();
    expect(before.some((model) => model.state === 'loaded')).toBe(true);

    const warmup = await ctx.processManager.warmup(E2E_MODEL);
    expect(warmup.attempted).toBe(false);
    expect(warmup.alreadyResident).toBe(true);

    // 状态接口、v0 状态列表、chat 模型列表三者一致：模型在内存里。
    const status = await api<{ modelLoaded?: string }>(ctx.baseUrl, 'GET', '/api/lmstudio/status');
    expect(status.body.modelLoaded).toBeTruthy();
    const after = await ctx.adapter.describeModels();
    const loaded = after.filter((model) => model.state === 'loaded').map((model) => model.id);
    expect(loaded.some((id) => id === modelId || id.startsWith(`${modelId}:`))).toBe(true);

    console.log(`[e2e] 预热跳过校验：alreadyResident=${String(warmup.alreadyResident)}，当前已加载实例=${loaded.join(', ')}`);
  }, 300_000);
});

describe('§5.3 中文 → 英文（真实流式）', () => {
  it('流式产出 delta，done 与拼接一致，并落库', async () => {
    const before = await entryPage(ctx.baseUrl, collectionId);

    const result = await streamTranslation(ctx.baseUrl, {
      collection_id: collectionId,
      source_lang: 'zh',
      target_lang: 'en',
      source_text: ZH_SOURCE,
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/event-stream');

    // 结构断言
    expect(result.frames.some((frame) => frame.event === 'error')).toBe(false);
    expect(result.frames[result.frames.length - 1]?.event).toBe('done');
    expect(result.deltas.length).toBeGreaterThan(0);

    const done = result.frames.find((frame) => frame.event === 'done');
    const targetText = String(done?.data.target_text ?? '');
    expect(result.deltas.join('')).toBe(targetText);
    expect(done?.data.model_id).toBe(modelId);
    expect(typeof done?.data.entry_id).toBe('string');

    // 'delta' 是增量：至少有一个分片不等于整段译文（除非模型只吐了一块）。
    if (result.deltas.length > 1) {
      expect(result.deltas[0]).not.toBe(targetText);
    }

    // 质量断言（宽松）：译文非空、没有替换字符、与原文不同，且确实是英文。
    expect(targetText.trim().length).toBeGreaterThan(0);
    expect(targetText).not.toContain('\uFFFD');
    expect(targetText).not.toBe(ZH_SOURCE);
    expect(latinRatio(targetText)).toBeGreaterThan(0.4);
    expect(cjkRatio(targetText)).toBeLessThan(0.2);

    // 落库与 done 完全一致，且合集计数 +1
    const after = await entryPage(ctx.baseUrl, collectionId);
    expect(after.total).toBe(before.total + 1);
    const saved = after.items.find((item) => item.id === done?.data.entry_id);
    expect(saved).toBeDefined();
    expect(saved?.source_text).toBe(ZH_SOURCE);
    expect(saved?.target_text).toBe(targetText);
    expect(saved?.source_lang).toBe('zh');
    expect(saved?.target_lang).toBe('en');
    expect(saved?.model_id).toBe(modelId);

    console.log(
      `[e2e] zh→en ${result.totalMs}ms（首个 delta ${result.firstDeltaMs ?? '-'}ms，${result.deltas.length} 个分片）\n      ${targetText}`,
    );
  }, 1_800_000);

  it('首个 delta 早于整段完成（证明是真流式，不是一次性返回）', async () => {
    const result = await streamTranslation(ctx.baseUrl, {
      collection_id: collectionId,
      source_lang: 'zh',
      target_lang: 'en',
      source_text: '流式输出应当逐段到达，而不是等全部生成完再一次性返回结果。',
    });

    expect(result.frames[result.frames.length - 1]?.event).toBe('done');
    expect(result.deltas.length).toBeGreaterThan(1);
    expect(result.firstDeltaMs).not.toBeNull();
    // 首块必须明显早于整体结束。
    expect(result.firstDeltaMs as number).toBeLessThan(result.totalMs);
  }, 1_800_000);
});

describe('§5.3 英文 → 中文（真实流式）', () => {
  it('反向方向产出中文译文并落库', async () => {
    const before = await entryPage(ctx.baseUrl, collectionId);

    const result = await streamTranslation(ctx.baseUrl, {
      collection_id: collectionId,
      source_lang: 'en',
      target_lang: 'zh',
      source_text: EN_SOURCE,
    });

    expect(result.status).toBe(200);
    expect(result.frames.some((frame) => frame.event === 'error')).toBe(false);

    const done = result.frames.find((frame) => frame.event === 'done');
    const targetText = String(done?.data.target_text ?? '');
    expect(result.deltas.join('')).toBe(targetText);
    expect(done?.data.model_id).toBe(modelId);

    expect(targetText).not.toBe(EN_SOURCE);
    expect(targetText).not.toContain('\uFFFD');
    expect(cjkRatio(targetText)).toBeGreaterThan(0.3);
    expect(latinRatio(targetText)).toBeLessThan(0.6);

    const after = await entryPage(ctx.baseUrl, collectionId);
    expect(after.total).toBe(before.total + 1);
    const saved = after.items.find((item) => item.id === done?.data.entry_id);
    expect(saved?.source_lang).toBe('en');
    expect(saved?.target_lang).toBe('zh');
    expect(saved?.target_text).toBe(targetText);

    console.log(
      `[e2e] en→zh ${result.totalMs}ms（首个 delta ${result.firstDeltaMs ?? '-'}ms，${result.deltas.length} 个分片）\n      ${targetText}`,
    );
  }, 1_800_000);
});

describe('§5.3 校验路径不触发真实推理', () => {
  it('超长原文立即返回 400 INPUT_TOO_LONG', async () => {
    // 用一个较小的上限，避免为了触发它真的拼一万字符。
    const limited = await createE2EContext();
    try {
      const target = await activeCollectionId(limited.baseUrl);
      const response = await fetch(`${limited.baseUrl}/api/translate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          collection_id: target,
          source_lang: 'zh',
          target_lang: 'en',
          source_text: 'x'.repeat(100_001),
        }),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('INPUT_TOO_LONG');

      const page = await entryPage(limited.baseUrl, target);
      expect(page.total).toBe(0);
    } finally {
      await limited.close();
    }
  }, 120_000);
});
