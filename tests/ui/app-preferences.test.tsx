// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../apps/web/src/App';
import { PREF_ACTIVE_COLLECTION, PREF_SOURCE_LANG } from '../../apps/web/src/preferences';

/**
 * App 级界面偏好恢复测试。
 *
 * 全部 JSON 接口都由本地替身提供（没有任何网络/模型依赖，因此可以留在常规套件里）：
 * - 翻译方向：刷新后应保持上次的选择；
 * - 上次选中的合集：服务端 active 与浏览器记忆不一致时补一次切换；一致时不打扰。
 *
 * 刻意不触发翻译流：jsdom 的 AbortSignal 与 Node fetch 不同 realm，流式请求在 jsdom
 * 里无法工作（那是测试环境的产物，不是产品缺陷）。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTION_A = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  name: '合集 A',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  entry_count: 0,
};
const COLLECTION_B = {
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  name: '合集 B',
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  entry_count: 0,
};

const LANG_KEY = `ots:pref:v1:${PREF_SOURCE_LANG}`;
const COLLECTION_KEY = `ots:pref:v1:${PREF_ACTIVE_COLLECTION}`;

interface Recorded {
  method: string;
  path: string;
}

interface Harness {
  calls: Recorded[];
  activeId: () => string;
  restore: () => void;
}

/** 安装一个记录请求的 fetch 替身；服务端 active 初始为 serverActiveId。 */
function installFetch(serverActiveId: string): Harness {
  const calls: Recorded[] = [];
  let active = serverActiveId;
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input);
    const path = raw.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (path === '/api/collections' && method === 'GET') {
      return json([COLLECTION_A, COLLECTION_B]);
    }
    if (path === '/api/collections/active' && method === 'GET') {
      const collection = active === COLLECTION_A.id ? COLLECTION_A : COLLECTION_B;
      return json({ collection });
    }
    if (path === '/api/collections/active' && method === 'PUT') {
      active = (body as { id: string }).id;
      const collection = active === COLLECTION_A.id ? COLLECTION_A : COLLECTION_B;
      return json({ collection });
    }
    if (path.startsWith('/api/collections/') && path.endsWith('/entries')) {
      return json({ items: [], total: 0, page: 1, pageSize: 50 });
    }
    if (path === '/api/lmstudio/status') {
      return json({ running: true, startedByUs: false, modelLoaded: 'fake-model' });
    }
    throw new Error(`未预期的请求：${method} ${path}`);
  }) as typeof fetch;

  return {
    calls,
    activeId: () => active,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let data: Map<string, string>;
let container: HTMLDivElement;
let root: Root | null = null;
let harness: Harness | null = null;

beforeEach(() => {
  data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    },
    configurable: true,
    writable: true,
  });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  harness?.restore();
  harness = null;
  Reflect.deleteProperty(globalThis, 'localStorage');
});

async function mountApp(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(App));
  });
  // 让列表加载完成（合集项渲染出来即视为就绪）。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.querySelectorAll('.collection-item').length > 0) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`合集列表未加载：${container.textContent ?? ''}`);
}

function activeDirectionButton(): string {
  const active = container.querySelector('.dir.active');
  return active?.textContent ?? '';
}

function selectedCollectionText(): string {
  const active = container.querySelector('.collection-item.active');
  return active?.querySelector('.collection-name')?.textContent ?? '';
}

describe('App：记住上次的界面选择', () => {
  it('翻译方向在重新挂载后保持不变', async () => {
    data.set(LANG_KEY, 'en');
    harness = installFetch(COLLECTION_A.id);

    await mountApp();
    expect(activeDirectionButton()).toBe('英 → 中');

    // 卸载后重新挂载（等价于刷新页面）。
    act(() => root?.unmount());
    root = null;
    container.innerHTML = '';
    await mountApp();
    expect(activeDirectionButton()).toBe('英 → 中');
  });

  it('浏览器记住的合集与服务端 active 一致时，不额外发切换请求', async () => {
    data.set(COLLECTION_KEY, COLLECTION_A.id);
    harness = installFetch(COLLECTION_A.id);

    await mountApp();

    expect(selectedCollectionText()).toContain('合集 A');
    const puts = harness.calls.filter(
      (call) => call.method === 'PUT' && call.path === '/api/collections/active',
    );
    expect(puts).toHaveLength(0);
  });

  it('服务端 active 被别处改过时，恢复到浏览器记住的合集', async () => {
    data.set(COLLECTION_KEY, COLLECTION_A.id);
    // 服务端记的是 B（例如另一个窗口切过）。
    harness = installFetch(COLLECTION_B.id);

    await mountApp();

    const puts = harness.calls.filter(
      (call) => call.method === 'PUT' && call.path === '/api/collections/active',
    );
    expect(puts).toHaveLength(1);
    expect(harness.activeId()).toBe(COLLECTION_A.id);
    expect(selectedCollectionText()).toContain('合集 A');
  });

  it('记住的合集已被删除时忽略它，并清掉失效的记忆', async () => {
    data.set(COLLECTION_KEY, 'cccccccc-3333-4333-8333-cccccccccccc');
    harness = installFetch(COLLECTION_B.id);

    await mountApp();

    const puts = harness.calls.filter(
      (call) => call.method === 'PUT' && call.path === '/api/collections/active',
    );
    expect(puts).toHaveLength(0);
    expect(selectedCollectionText()).toContain('合集 B');
    expect(data.has(COLLECTION_KEY)).toBe(false);
  });

  it('点击合集会把选择写进记忆', async () => {
    harness = installFetch(COLLECTION_A.id);
    await mountApp();
    expect(selectedCollectionText()).toContain('合集 A');

    // 切换合集走的是列表项里的 .collection-main 按钮。
    const target = Array.from(container.querySelectorAll('.collection-item')).find((item) =>
      item.querySelector('.collection-name')?.textContent?.includes('合集 B'),
    );
    const switchButton = target?.querySelector('.collection-main');
    expect(switchButton).not.toBeNull();
    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(harness.activeId()).toBe(COLLECTION_B.id);
    expect(data.get(COLLECTION_KEY)).toBe(COLLECTION_B.id);
  });
});
