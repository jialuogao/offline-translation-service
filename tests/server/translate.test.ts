import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { Collection, EntryPage } from '@ots/contracts';
import { expectedTranslation, startMockServer, type MockServer, type MockServerOptions } from '../mock-lmstudio/server.js';
import { createTestContext, type TestContext } from '../helpers/context.js';
import { api, readSse, waitFor, type SseEvent } from '../helpers/http.js';

/** 流式翻译端到端测试（DESIGN.md §5.3 / §7 / §8.3 / §9.4）。 */

let mock: MockServer;
let ctx: TestContext;
let collectionId: string;

beforeEach(async () => {
  mock = await startMockServer({ chunkSize: 4 });
  ctx = await createTestContext({ lmStudioBaseUrl: mock.baseUrl });
  collectionId = (
    await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
  ).body[0]?.id as string;
});

afterEach(async () => {
  delete process.env.OTS_TEST_MOCK_QUERY;
  delete process.env.OTS_TEST_MOCK_HEADERS;
  await ctx.close();
  await mock.close();
});

function translateBody(sourceText: string, sourceLang = 'zh', targetLang = 'en'): unknown {
  return { collection_id: collectionId, source_lang: sourceLang, target_lang: targetLang, source_text: sourceText };
}

function deltas(events: SseEvent[]): string {
  return events
    .filter((event) => event.event === 'delta')
    .map((event) => String(event.data.text ?? ''))
    .join('');
}

async function entries(): Promise<EntryPage> {
  return (
    await api<EntryPage>(ctx.baseUrl, 'GET', `/api/collections/${collectionId}/entries`)
  ).body;
}

describe('§5.3 中→英 流式翻译', () => {
  it('发出多个 delta 后以 done 结束，并落库一条历史', async () => {
    const response = await readSse(ctx.baseUrl, '/api/translate/stream', translateBody('你好世界'));

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');

    const events = response.events;
    const deltaEvents = events.filter((event) => event.event === 'delta');
    expect(deltaEvents.length).toBeGreaterThan(1);

    const done = events.find((event) => event.event === 'done');
    expect(done).toBeDefined();
    expect(events[events.length - 1]?.event).toBe('done');

    const expectedText = expectedTranslation('zh', '你好世界');
    expect(deltas(events)).toBe(expectedText);
    expect(done?.data.target_text).toBe(expectedText);
    expect(done?.data.model_id).toBe('mock-hy-mt2-30b-a3b');
    expect(typeof done?.data.entry_id).toBe('string');

    const page = await entries();
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(done?.data.entry_id);
    expect(page.items[0]?.source_text).toBe('你好世界');
    expect(page.items[0]?.target_text).toBe(expectedText);
    expect(page.items[0]?.source_lang).toBe('zh');
    expect(page.items[0]?.target_lang).toBe('en');
    expect(page.items[0]?.collection_id).toBe(collectionId);
  });

  it('§5.3 落库会更新所属合集的 updated_at', async () => {
    const before = (
      await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
    ).body.find((item) => item.id === collectionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await readSse(ctx.baseUrl, '/api/translate/stream', translateBody('更新时间'));
    const after = (
      await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
    ).body.find((item) => item.id === collectionId);
    expect(after?.entry_count).toBe(1);
    expect(after !== undefined && before !== undefined && after.updated_at >= before.updated_at).toBe(
      true,
    );
  });
});

describe('§8.3 英→中 流式翻译', () => {
  it('反向方向产出确定性中文译文', async () => {
    const response = await readSse(
      ctx.baseUrl,
      '/api/translate/stream',
      translateBody('Hello world', 'en', 'zh'),
    );
    const expectedText = expectedTranslation('en', 'Hello world');
    expect(deltas(response.events)).toBe(expectedText);
    const page = await entries();
    expect(page.items[0]?.target_lang).toBe('zh');
    expect(page.items[0]?.target_text).toBe(expectedText);
  });
});

describe('§5.3 输入校验', () => {
  it('超过 TRANSLATE_MAX_CHARS 返回 400 INPUT_TOO_LONG 且不发起翻译', async () => {
    const limited = await createTestContext({ lmStudioBaseUrl: mock.baseUrl, maxChars: 10 });
    try {
      const target = (
        await api<Collection[]>(limited.baseUrl, 'GET', '/api/collections')
      ).body[0]?.id as string;
      const response = await readSse(limited.baseUrl, '/api/translate/stream', {
        collection_id: target,
        source_lang: 'zh',
        target_lang: 'en',
        source_text: 'x'.repeat(11),
      });
      expect(response.status).toBe(400);
      expect(response.contentType).toContain('application/json');
      const page = await api<EntryPage>(
        limited.baseUrl,
        'GET',
        `/api/collections/${target}/entries`,
      );
      expect(page.body.total).toBe(0);
    } finally {
      await limited.close();
    }
  });

  it('方向非法返回 400 INVALID_REQUEST', async () => {
    const same = await readSse(ctx.baseUrl, '/api/translate/stream', translateBody('你好', 'zh', 'zh'));
    expect(same.status).toBe(400);

    const unknownLang = await readSse(ctx.baseUrl, '/api/translate/stream', {
      collection_id: collectionId,
      source_lang: 'jp',
      target_lang: 'en',
      source_text: '你好',
    });
    expect(unknownLang.status).toBe(400);
    expect((unknownLang as unknown as { events: SseEvent[] }).events).toHaveLength(0);
  });

  it('合集不存在返回 404 COLLECTION_NOT_FOUND', async () => {
    const response = await readSse(ctx.baseUrl, '/api/translate/stream', {
      collection_id: '不存在',
      source_lang: 'zh',
      target_lang: 'en',
      source_text: '你好',
    });
    expect(response.status).toBe(404);
    const page = await entries();
    expect(page.total).toBe(0);
  });

  it('空原文返回 400 INVALID_REQUEST', async () => {
    const response = await readSse(ctx.baseUrl, '/api/translate/stream', translateBody('   '));
    expect(response.status).toBe(400);
  });
});

describe('§6.5 / §8.3 LM Studio 不可达', () => {
  it('上游 503 时发出 error 事件且不落库', async () => {
    process.env.OTS_TEST_MOCK_QUERY = 'mock_fail=lmstudio_down';
    const response = await readSse(ctx.baseUrl, '/api/translate/stream', translateBody('不可达'));
    expect(response.status).toBe(200);
    const errorEvent = response.events.find((event) => event.event === 'error');
    expect(errorEvent?.data.error).toBe('LMSTUDIO_UNAVAILABLE');
    expect(typeof errorEvent?.data.message).toBe('string');
    const page = await entries();
    expect(page.total).toBe(0);
  });

  it('端点完全不可达时同样降级为 error 事件', async () => {
    const offline = await createTestContext({ lmStudioBaseUrl: 'http://127.0.0.1:65530' });
    try {
      const target = (
        await api<Collection[]>(offline.baseUrl, 'GET', '/api/collections')
      ).body[0]?.id as string;
      const response = await readSse(offline.baseUrl, '/api/translate/stream', {
        collection_id: target,
        source_lang: 'zh',
        target_lang: 'en',
        source_text: '离线',
      });
      expect(response.events.find((event) => event.event === 'error')?.data.error).toBe(
        'LMSTUDIO_UNAVAILABLE',
      );
    } finally {
      await offline.close();
    }
  });
});

describe('§8.3 流式中途断流', () => {
  it('发出 error 事件，且不落库半成品', async () => {
    process.env.OTS_TEST_MOCK_QUERY = 'mock_fail=mid_stream_cut';
    const response = await readSse(ctx.baseUrl, '/api/translate/stream', translateBody('中途断流'));
    const errorEvent = response.events.find((event) => event.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.error).toBe('LMSTUDIO_UNAVAILABLE');
    expect(response.events.some((event) => event.event === 'done')).toBe(false);

    const page = await entries();
    expect(page.total).toBe(0);
  });
});

describe('§9.4 并发控制', () => {
  it('同一合集已有在飞请求时返回 409 TRANSLATION_IN_FLIGHT', async () => {
    const hanging = await startMockServer({});
    const busy = await createTestContext({ lmStudioBaseUrl: hanging.baseUrl });
    try {
      const target = (
        await api<Collection[]>(busy.baseUrl, 'GET', '/api/collections')
      ).body[0]?.id as string;

      // 用 hang 让第一个请求一直处于在飞状态。
      process.env.OTS_TEST_MOCK_QUERY = 'mock_fail=hang';
      const controller = new AbortController();
      const first = fetch(`${busy.baseUrl}/api/translate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          collection_id: target,
          source_lang: 'zh',
          target_lang: 'en',
          source_text: '占用中',
        }),
        signal: controller.signal,
      }).catch(() => undefined);

      await waitFor(() => busy.translations.isInFlight(target), { label: '第一个请求进入在飞状态' });

      const second = await api<{ error: string }>(busy.baseUrl, 'POST', '/api/translate/stream', {
        collection_id: target,
        source_lang: 'zh',
        target_lang: 'en',
        source_text: '第二个',
      });
      expect(second.status, JSON.stringify(second.body)).toBe(409);
      expect(second.body.error).toBe('TRANSLATION_IN_FLIGHT');

      controller.abort();
      await first;
      await waitFor(() => !busy.translations.isInFlight(target), { label: '在飞状态释放' });
    } finally {
      delete process.env.OTS_TEST_MOCK_QUERY;
      await busy.close();
      await hanging.close();
    }
  });

  it('不同合集可以并发（§9.4）', async () => {
    const hanging = await startMockServer({});
    const concurrent = await createTestContext({ lmStudioBaseUrl: hanging.baseUrl });
    try {
      const collections = await api<Collection[]>(concurrent.baseUrl, 'GET', '/api/collections');
      const first = collections.body[0]?.id as string;
      const second = (
        await api<Collection>(concurrent.baseUrl, 'POST', '/api/collections', { name: '第二个' })
      ).body.id;

      process.env.OTS_TEST_MOCK_QUERY = 'mock_fail=hang';
      const controller = new AbortController();
      const pending = fetch(`${concurrent.baseUrl}/api/translate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          collection_id: first,
          source_lang: 'zh',
          target_lang: 'en',
          source_text: '合集一',
        }),
        signal: controller.signal,
      }).catch(() => undefined);

      await waitFor(() => concurrent.translations.isInFlight(first), { label: '合集一在飞' });

      // 另一个合集不应被 409 拦下（同样挂起，因此这里只断言它被接受）。
      const otherController = new AbortController();
      const other = fetch(`${concurrent.baseUrl}/api/translate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          collection_id: second,
          source_lang: 'en',
          target_lang: 'zh',
          source_text: 'collection two',
        }),
        signal: otherController.signal,
      }).catch(() => undefined);
      await waitFor(() => concurrent.translations.isInFlight(second), { label: '合集二在飞' });

      controller.abort();
      otherController.abort();
      await Promise.all([pending, other]);
    } finally {
      delete process.env.OTS_TEST_MOCK_QUERY;
      await concurrent.close();
      await hanging.close();
    }
  });
});

describe('§9.4 客户端断开', () => {
  it('断开后取消上游请求且不落库', async () => {
    const hangingOptions: MockServerOptions = {};
    const hanging = await startMockServer(hangingOptions);
    // 让上游停在"已发送响应头、还在等模型输出"的状态。
    process.env.OTS_TEST_MOCK_QUERY = 'mock_fail=hang';
    const streamCtx = await createTestContext({ lmStudioBaseUrl: hanging.baseUrl });
    try {
      const target = (
        await api<Collection[]>(streamCtx.baseUrl, 'GET', '/api/collections')
      ).body[0]?.id as string;

      // 用一个原始 http 请求，才能真实模拟"页面被关闭/连接被切断"。
      let markArrived: (() => void) | undefined;
      const arrived = new Promise<void>((resolve) => {
        markArrived = resolve;
      });
      hangingOptions.onRequest = (info) => {
        if (info.url.startsWith('/v1/chat/completions')) markArrived?.();
      };
      const request = http.request({
        host: '127.0.0.1',
        port: streamCtx.port,
        method: 'POST',
        path: '/api/translate/stream',
        headers: { 'content-type': 'application/json' },
      });
      request.on('error', () => {
        /* 主动销毁会触发 ECONNRESET，测试中忽略 */
      });
      request.end(
        JSON.stringify({
          collection_id: target,
          source_lang: 'zh',
          target_lang: 'en',
          source_text: '断开测试',
        }),
      );
      // 等上游真的收到请求，确保切断发生在翻译进行中。
      await arrived;
      request.destroy();

      await waitFor(() => !streamCtx.translations.isInFlight(target), {
        label: '断开后在飞状态释放',
      });
      const page = await api<EntryPage>(
        streamCtx.baseUrl,
        'GET',
        `/api/collections/${target}/entries`,
      );
      expect(page.body.total).toBe(0);
    } finally {
      await streamCtx.close();
      await hanging.close();
    }
  });
});

describe('§5.4 LM Studio 状态与模型列表', () => {
  it('status 反映 running 与已加载模型（startedByUs 已于 §6.4 重新决定后删除）', async () => {
    const status = await api<{ running: boolean; modelLoaded?: string; startedByUs?: boolean }>(
      ctx.baseUrl,
      'GET',
      '/api/lmstudio/status',
    );
    expect(status.status).toBe(200);
    expect(status.body.running).toBe(true);
    expect(status.body.modelLoaded).toBe('mock-hy-mt2-30b-a3b');
    // 归属字段已从契约中移除，响应里不应再出现。
    expect(status.body).not.toHaveProperty('startedByUs');
  });

  it('models 返回 Mock 的模型 id', async () => {
    const models = await api<{ models: string[] }>(ctx.baseUrl, 'GET', '/api/lmstudio/models');
    expect(models.body.models).toEqual(['mock-hy-mt2-30b-a3b']);
  });

  it('models 在端点不可达时返回空列表而不是 500', async () => {
    const offline = await createTestContext({ lmStudioBaseUrl: 'http://127.0.0.1:65530' });
    try {
      const status = await api<{ running: boolean }>(offline.baseUrl, 'GET', '/api/lmstudio/status');
      expect(status.body.running).toBe(false);
      const models = await api<{ models: string[] }>(offline.baseUrl, 'GET', '/api/lmstudio/models');
      expect(models.status).toBe(200);
      expect(models.body.models).toEqual([]);
    } finally {
      await offline.close();
    }
  });
});
