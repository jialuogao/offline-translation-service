// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../apps/web/src/App';

/**
 * 历史列表多选回归测试（DESIGN.md §9.2）。
 *
 * 只验证选择语义在 DOM 上是否正确：checkbox 点选、Ctrl+点击切换、Shift+点击
 * 连续范围选择、表头全选，以及顶部"已选 N 条"操作条的出现/计数。删除动作本身
 * 由 tests/server 覆盖。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTION = {
  id: 'aaaa0000-0000-4000-8000-000000000001',
  name: '合集',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  entry_count: 4,
};

function makeEntry(id: string): {
  id: string;
  collection_id: string;
  source_lang: 'zh';
  target_lang: 'en';
  source_text: string;
  target_text: string;
  model_id: string | null;
  created_at: string;
} {
  return {
    id,
    collection_id: COLLECTION.id,
    source_lang: 'zh',
    target_lang: 'en',
    source_text: `原文-${id}`,
    target_text: `EN[${id}]`,
    model_id: 'mock',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

const ENTRIES = [makeEntry('e-1'), makeEntry('e-2'), makeEntry('e-3'), makeEntry('e-4')];

function installFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input);
    const path = raw.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/api/collections' && method === 'GET') {
      return json([{ ...COLLECTION, entry_count: ENTRIES.length }]);
    }
    if (path === '/api/collections/active' && method === 'GET') {
      return json({ collection: COLLECTION });
    }
    if (path.startsWith('/api/collections/') && path.includes('/entries')) {
      return json({ items: ENTRIES, total: ENTRIES.length, page: 1, pageSize: 50 });
    }
    if (path === '/api/lmstudio/status') {
      return json({ running: true, modelLoaded: 'fake-model' });
    }
    throw new Error(`未预期的请求：${method} ${path}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function mountApp(container: HTMLElement): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.querySelectorAll('.history-row').length >= ENTRIES.length) return root;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`历史列表未加载：${container.textContent ?? ''}`);
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.history-row:not(.streaming)')) as HTMLElement[];
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll('.history-row:not(.streaming) .cell-check input'),
  ) as HTMLInputElement[];
}

function clickCheckbox(container: HTMLElement, rowIndex: number): void {
  const input = checkboxes(container)[rowIndex];
  act(() => {
    input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function clickRowBody(container: HTMLElement, rowIndex: number, opts: { ctrl?: boolean; shift?: boolean } = {}): void {
  const row = rows(container)[rowIndex];
  const cell = row?.querySelector('.cell-source') as HTMLElement | null;
  act(() => {
    cell?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: opts.ctrl ?? false, shiftKey: opts.shift ?? false }),
    );
  });
}

function selectionBarText(container: HTMLElement): string | null {
  return container.querySelector('.selection-bar')?.textContent ?? null;
}

describe('历史列表多选（§9.2）', () => {
  it('删除单条历史记录前要求确认', async () => {
    const restore = installFetch();
    const container = document.createElement('div');
    document.body.append(container);
    try {
      await mountApp(container);
      const deleteButton = rows(container)[0]?.querySelector('button');
      act(() => {
        deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('[role="dialog"]')?.textContent).toContain('删除记录');
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
        '确定删除这条翻译记录吗？',
      );
    } finally {
      document.body.removeChild(container);
      restore();
    }
  });

  it('点击两个 checkbox 可同时选中，操作条计数为 2', async () => {
    const restore = installFetch();
    const container = document.createElement('div');
    document.body.append(container);
    try {
      await mountApp(container);
      clickCheckbox(container, 0);
      clickCheckbox(container, 2);
      expect(selectionBarText(container)).toContain('已选 2 条');
      expect(checkboxes(container)[0]?.checked).toBe(true);
      expect(checkboxes(container)[2]?.checked).toBe(true);
      expect(checkboxes(container)[1]?.checked).toBe(false);
    } finally {
      document.body.removeChild(container);
      restore();
    }
  });

  it('Ctrl+点击切换选中态，不改变其他选择', async () => {
    const restore = installFetch();
    const container = document.createElement('div');
    document.body.append(container);
    try {
      await mountApp(container);
      clickCheckbox(container, 0);
      clickRowBody(container, 2, { ctrl: true });
      expect(selectionBarText(container)).toContain('已选 2 条');
      // 再 Ctrl+点击一次，第 3 行取消。
      clickRowBody(container, 2, { ctrl: true });
      expect(selectionBarText(container)).toContain('已选 1 条');
    } finally {
      document.body.removeChild(container);
      restore();
    }
  });

  it('Shift+点击从锚点连续选中区间', async () => {
    const restore = installFetch();
    const container = document.createElement('div');
    document.body.append(container);
    try {
      await mountApp(container);
      // 先点第 1 行作为锚点。
      clickRowBody(container, 0);
      // Shift+点击第 3 行：0..2 全选。
      clickRowBody(container, 2, { shift: true });
      expect(selectionBarText(container)).toContain('已选 3 条');
      expect(checkboxes(container)[0]?.checked).toBe(true);
      expect(checkboxes(container)[1]?.checked).toBe(true);
      expect(checkboxes(container)[2]?.checked).toBe(true);
      expect(checkboxes(container)[3]?.checked).toBe(false);
    } finally {
      document.body.removeChild(container);
      restore();
    }
  });

  it('表头 checkbox 全选当前页', async () => {
    const restore = installFetch();
    const container = document.createElement('div');
    document.body.append(container);
    try {
      await mountApp(container);
      const headerCheck = container.querySelector(
        '.history-head .cell-check input',
      ) as HTMLInputElement | null;
      act(() => {
        headerCheck?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(selectionBarText(container)).toContain(`已选 ${ENTRIES.length} 条`);
    } finally {
      document.body.removeChild(container);
      restore();
    }
  });
});
