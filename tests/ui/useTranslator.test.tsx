// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTranslator, type UseTranslatorResult } from '../../apps/web/src/hooks/useTranslator';

/**
 * 译文输出框的数据流测试（DESIGN.md §9.1 / §9.3）。
 *
 * 分工说明：
 * - 这里只测**状态机**：把 SSE 客户端 `streamTranslation` 打桩，验证 delta 累加、
 *   done 后产出 `lastResult`（输出框据此显示最终译文）、断流/错误不产出结果。
 * - 真实的 HTTP + SSE 解析由 `tests/server/translate.test.ts` 与
 *   `tests/unit/adapter.test.ts` 覆盖；渲染位置由 `translator.test.tsx` 覆盖。
 *
 * 为什么不用真实 fetch：jsdom 会给 `AbortSignal` 造一个自己 realm 的副本，Node 的
 * `fetch` 拒绝它（`Expected signal to be an instance of AbortSignal`），那是测试环境
 * 的产物，不是产品缺陷，因此不在这里制造这种耦合。
 */

const streamTranslationMock = vi.hoisted(() => vi.fn());

vi.mock('../../apps/web/src/api/translate', () => ({
  streamTranslation: streamTranslationMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type StreamEvent = { type: 'delta'; text: string } | { type: 'done'; done: unknown };

/** 用给定事件序列打桩一次流式翻译。 */
function stubStream(events: StreamEvent[]): void {
  streamTranslationMock.mockImplementation(async function* () {
    for (const event of events) {
      yield event;
    }
  });
}

/** 打桩成"发出若干 delta 后抛错"，模拟断流。 */
function stubStreamThatThrows(partial: string[], message: string): void {
  streamTranslationMock.mockImplementation(async function* () {
    for (const text of partial) {
      yield { type: 'delta', text };
    }
    throw new Error(message);
  });
}

interface HookHandle {
  current: UseTranslatorResult;
  root: Root;
  container: HTMLDivElement;
}

function renderHook(): HookHandle {
  const container = document.createElement('div');
  document.body.append(container);
  const box: { value: UseTranslatorResult | null } = { value: null };

  function Probe(): null {
    const translator = useTranslator();
    const ref = useRef(box);
    ref.current.value = translator;
    return null;
  }

  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  if (box.value === null) throw new Error('hook 未初始化');
  return {
    root,
    container,
    get current(): UseTranslatorResult {
      return box.value as UseTranslatorResult;
    },
  };
}

const request = {
  collection_id: 'c1',
  source_lang: 'zh' as const,
  target_lang: 'en' as const,
  source_text: '你好世界',
};

function doneEvent(targetText: string): StreamEvent {
  return {
    type: 'done',
    done: { entry_id: 'entry-1', target_text: targetText, model_id: 'mock-model' },
  };
}

let hook: HookHandle;

beforeEach(() => {
  streamTranslationMock.mockReset();
  hook = renderHook();
});

afterEach(() => {
  act(() => {
    hook.root.unmount();
  });
  hook.container.remove();
});

async function run(overrides: Partial<typeof request> = {}): Promise<void> {
  await act(async () => {
    await hook.current.run({ ...request, ...overrides });
  });
}

describe('useTranslator 的输出框状态', () => {
  it('done 后产出 lastResult：译文、entry_id、model_id 与合集归属', async () => {
    stubStream([
      { type: 'delta', text: 'The ' },
      { type: 'delta', text: 'local ' },
      { type: 'delta', text: 'service works.' },
      doneEvent('The local service works.'),
    ]);

    await run();

    expect(hook.current.lastResult).not.toBeNull();
    expect(hook.current.lastResult?.targetText).toBe('The local service works.');
    expect(hook.current.lastResult?.entryId).toBe('entry-1');
    expect(hook.current.lastResult?.modelId).toBe('mock-model');
    expect(hook.current.lastResult?.collectionId).toBe('c1');
    expect(hook.current.lastResult?.sourceText).toBe('你好世界');
    expect(hook.current.lastResult?.sourceLang).toBe('zh');
    expect(hook.current.lastResult?.targetLang).toBe('en');
    // done 之后 live 收起、无在飞状态。
    expect(hook.current.live).toBeNull();
    expect(hook.current.anyInFlight).toBe(false);
    expect(hook.current.error).toBeNull();
  });

  it('流式期间 live 累积 delta（输出框实时增长）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamTranslationMock.mockImplementation(async function* () {
      yield { type: 'delta', text: 'First' };
      await gate;
      yield { type: 'delta', text: ' second' };
      yield doneEvent('First second');
    });

    let running: Promise<void> | null = null;
    await act(async () => {
      running = hook.current.run({ ...request });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // 中途：live 已累积第一段，lastResult 还没有。
    expect(hook.current.live?.targetText).toBe('First');
    expect(hook.current.lastResult).toBeNull();
    expect(hook.current.anyInFlight).toBe(true);

    await act(async () => {
      release?.();
      await running;
    });

    expect(hook.current.live).toBeNull();
    expect(hook.current.lastResult?.targetText).toBe('First second');
  });

  it('断流：不产出 lastResult，给出错误，并保留已收到的部分译文供查看', async () => {
    stubStreamThatThrows(['Partial'], '翻译流意外中断，未保存任何内容');

    await run();

    expect(hook.current.lastResult).toBeNull();
    expect(hook.current.error).toContain('未保存任何内容');
    // 未完成的部分不算结果，但用户能看到收到过什么（通常只是几个字符）。
    expect(hook.current.live?.targetText).toBe('Partial');
    expect(hook.current.anyInFlight).toBe(false);
  });

  it('错误路径（如 LM Studio 不可用）：不产出 lastResult', async () => {
    stubStreamThatThrows([], '无法连接 LM Studio');

    await run();

    expect(hook.current.lastResult).toBeNull();
    expect(hook.current.error).toBe('无法连接 LM Studio');
  });

  it('取消翻译：live 收起且不产出 lastResult', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamTranslationMock.mockImplementation(async function* (_request: unknown, signal: AbortSignal) {
      yield { type: 'delta', text: 'Hel' };
      await gate;
      if (signal.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }
      yield doneEvent('Hello');
    });

    let running: Promise<void> | null = null;
    await act(async () => {
      running = hook.current.run({ ...request });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(hook.current.live?.targetText).toBe('Hel');

    await act(async () => {
      hook.current.cancel();
      release?.();
      await running;
    });

    expect(hook.current.live).toBeNull();
    expect(hook.current.lastResult).toBeNull();
    expect(hook.current.anyInFlight).toBe(false);
    // 主动取消不算错误。
    expect(hook.current.error).toBeNull();
  });

  it('已在飞时忽略新的翻译请求（不排队）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamTranslationMock.mockImplementation(async function* () {
      yield { type: 'delta', text: 'A' };
      await gate;
      yield doneEvent('A');
    });

    let first: Promise<void> | null = null;
    await act(async () => {
      first = hook.current.run({ ...request });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // 第二次调用应立即返回，且不产生第二个请求。
    await act(async () => {
      await hook.current.run({ ...request, source_text: '第二个' });
    });
    expect(streamTranslationMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await first;
    });
    expect(hook.current.lastResult?.targetText).toBe('A');
  });

  it('dismissResult 只清空输出框内容', async () => {
    stubStream([{ type: 'delta', text: 'X' }, doneEvent('X')]);
    await run();
    expect(hook.current.lastResult).not.toBeNull();

    act(() => {
      hook.current.dismissResult();
    });

    expect(hook.current.lastResult).toBeNull();
    expect(hook.current.error).toBeNull();
    expect(hook.current.anyInFlight).toBe(false);
  });

  it('lastResult 按合集区分：不同合集的结果互不混淆', async () => {
    stubStream([{ type: 'delta', text: 'First' }, doneEvent('First')]);
    await run({ collection_id: 'c1' });

    stubStream([{ type: 'delta', text: 'Second' }, doneEvent('Second')]);
    await run({ collection_id: 'c2' });

    // 只保留最近一次结果，但归属明确，App 会按当前合集决定是否展示。
    expect(hook.current.lastResult?.collectionId).toBe('c2');
    expect(hook.current.lastResult?.targetText).toBe('Second');
  });
});
