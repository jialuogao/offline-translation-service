import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockServer, expectedTranslation, type MockServer } from '../mock-lmstudio/server.js';
import { LMStudioAdapter, LMStudioError } from '../../apps/server/src/lmstudio/adapter.js';
import { listenOnSafePort } from '../helpers/paths.js';

/** LMStudioAdapter 与 Mock 的对接测试（DESIGN.md §7.2 / §8.2）。 */

const servers: MockServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await server.close();
  }
});

async function mockAdapter(options: { chunkSize?: number } = {}): Promise<{
  adapter: LMStudioAdapter;
  server: MockServer;
}> {
  const server = await startMockServer(options);
  servers.push(server);
  return {
    server,
    adapter: new LMStudioAdapter({ baseUrl: server.baseUrl, probeTimeoutMs: 2_000 }),
  };
}

describe('LMStudioAdapter', () => {
  it('列出模型并可判定可达', async () => {
    const { adapter, server } = await mockAdapter();
    expect(await adapter.listModels()).toEqual(['mock-hy-mt2-30b-a3b']);
    expect(await adapter.isReachable()).toBe(true);
    expect(server.port).toBeGreaterThan(0);
  });

  it('§7.1 model 解析顺序：显式 > 配置 > 列表首个', async () => {
    const { adapter, server } = await mockAdapter();
    expect(await adapter.resolveModel()).toBe('mock-hy-mt2-30b-a3b');
    expect(await adapter.resolveModel('显式模型')).toBe('显式模型');

    const configured = new LMStudioAdapter({
      baseUrl: server.baseUrl,
      probeTimeoutMs: 2_000,
      model: '配置模型',
    });
    expect(await configured.resolveModel()).toBe('配置模型');
  });

  it('§7.2 逐块产出 delta 并可拼接为完整译文', async () => {
    const { adapter } = await mockAdapter({ chunkSize: 3 });
    const stream = await adapter.chatCompletion({
      messages: [
        { role: 'system', content: 'You are a professional translator. Translate from Chinese to English.' },
        { role: 'user', content: '你好世界' },
      ],
      extraHeaders: { 'X-Mock-Source-Lang': 'zh' },
    });
    const parts: string[] = [];
    for await (const delta of stream.deltas) parts.push(delta);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(expectedTranslation('zh', '你好世界'));
    expect(stream.model).toBe('mock-hy-mt2-30b-a3b');
  });

  it('§7.2 多字节字符不会被拆断（按字符切分而非字节）', async () => {
    const { adapter } = await mockAdapter({ chunkSize: 1 });
    const stream = await adapter.chatCompletion({
      messages: [{ role: 'user', content: '中文测试' }],
      extraHeaders: { 'X-Mock-Source-Lang': 'en' },
    });
    const parts: string[] = [];
    for await (const delta of stream.deltas) parts.push(delta);
    expect(parts.join('')).toBe(expectedTranslation('en', '中文测试'));
    expect(parts.every((part) => part.length > 0)).toBe(true);
  });

  it('§8.2 端点不可达时 isReachable=false，请求抛 LMSTUDIO_UNAVAILABLE', async () => {
    // 65530 上没有监听者。不要用 6543 之类的低端口：Node 的 fetch 会把它们当成
    // 被浏览器屏蔽的端口直接拒绝（bad port），那样测到的是 fetch 的限制而非不可达。
    const adapter = new LMStudioAdapter({ baseUrl: 'http://127.0.0.1:65530', probeTimeoutMs: 500 });
    expect(await adapter.isReachable()).toBe(false);
    await expect(adapter.listModels()).rejects.toBeInstanceOf(LMStudioError);
    await expect(adapter.listModels()).rejects.toMatchObject({ code: 'LMSTUDIO_UNAVAILABLE' });
  });

  it('§8.2 上游 503 映射为 LMSTUDIO_UNAVAILABLE', async () => {
    const { adapter } = await mockAdapter();
    await expect(
      adapter.chatCompletion({
        messages: [{ role: 'user', content: '你好' }],
        query: { mock_fail: 'lmstudio_down' },
      }),
    ).rejects.toMatchObject({ code: 'LMSTUDIO_UNAVAILABLE' });
  });

  it('§8.2 上游发完首块后断流：迭代时抛错，不静默收尾', async () => {
    // Mock 的 `mid_stream_cut` 会立刻断开；要验证"已经收到 delta 之后才断流"，
    // 这里用一个本地小服务器精确控制：先发若干块，再摧毁 socket。
    const cutting = await startCuttingServer(3);
    const port = (cutting.server.address() as AddressInfo).port;
    const adapter = new LMStudioAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      probeTimeoutMs: 1_000,
    });
    try {
      const stream = await adapter.chatCompletion({
        messages: [{ role: 'user', content: '断流内容' }],
        extraHeaders: { 'X-Mock-Source-Lang': 'zh' },
      });
      const parts: string[] = [];
      await expect(
        (async () => {
          for await (const delta of stream.deltas) parts.push(delta);
        })(),
      ).rejects.toBeInstanceOf(Error);
      expect(parts).toEqual(['一', '二', '三']);
      expect(cutting.requests()).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        cutting.server.closeAllConnections?.();
        cutting.server.close(() => resolve());
      });
    }
  });

  it('§13-5 describeModels 读取 state，loadModel 尽力而为', async () => {
    const { adapter } = await mockAdapter();
    const models = await adapter.describeModels();
    // Mock 未实现 /api/v0/models，降级后 state 记为 unknown。
    expect(models).toEqual([{ id: 'mock-hy-mt2-30b-a3b', state: 'unknown' }]);
    // Mock 未实现 /api/v1/models/load：必须返回 false 而不是抛出。
    expect(await adapter.loadModel('mock-hy-mt2-30b-a3b')).toBe(false);
  });

  it('§9.4 abort 会终止流式迭代', async () => {
    const { adapter } = await mockAdapter();
    const controller = new AbortController();
    const stream = await adapter.chatCompletion({
      messages: [{ role: 'user', content: '悬挂测试' }],
      query: { mock_fail: 'hang' },
      signal: controller.signal,
    });
    const iterator = stream.deltas[Symbol.asyncIterator]();
    const pending = iterator.next();
    // 等 socket 真正建立，确保 abort 监听已挂上。
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });
});

/** 先发 `chunkCount` 个 delta，再摧毁 socket 的本地服务器。 */
async function startCuttingServer(
  chunkCount: number,
): Promise<{ server: http.Server; requests: () => number }> {
  let chatRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'cutting-model', object: 'model' }] }));
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions') !== true) {
      res.writeHead(404).end();
      return;
    }
    chatRequests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    for (const chunk of ['一', '二', '三', '四'].slice(0, chunkCount)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    setTimeout(() => res.socket?.destroy(), 30);
  });
  // 同样避开 listen(0)：临时端口可能落在 fetch 的拒绝列表里。
  await listenOnSafePort(
    (port) =>
      new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', () => resolveListen());
      }),
  );
  return { server, requests: () => chatRequests };
}
