// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Translator } from '../../apps/web/src/components/Translator';

/**
 * 译文输出框的 DOM 回归测试（DESIGN.md §9.1）。
 *
 * 只验证渲染结构：输出框必须在**原文输入框之后**，并且内容随流式增量更新、
 * 完成后保留。翻译业务本身由 tests/server/translate.test.ts 覆盖。
 */

// 让 React 18 认得以 act(...) 包裹的更新，否则每次渲染都会打印告警。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RenderOptions {
  outputText?: string;
  outputStreaming?: boolean;
  outputSaved?: boolean;
}

function render(container: HTMLElement, options: RenderOptions = {}): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <Translator
        sourceText="待翻译的原文"
        sourceLang="zh"
        targetLang="en"
        onSourceTextChange={() => undefined}
        onDirectionChange={() => undefined}
        onTranslate={() => undefined}
        onCancel={() => undefined}
        translating={options.outputStreaming ?? false}
        disabled={false}
        maxChars={10000}
        outputText={options.outputText ?? ''}
        outputStreaming={options.outputStreaming ?? false}
        outputSaved={options.outputSaved ?? false}
        outputModelId={options.outputSaved === true ? 'mock-model' : null}
        onClearOutput={() => undefined}
      />,
    );
  });
  return root;
}

function input(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('.source-input') as HTMLTextAreaElement;
}

function output(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector('#translation-output');
}

describe('译文输出框', () => {
  it('渲染在原文输入框下方，且初始为空', () => {
    const container = document.createElement('div');
    const root = render(container);

    const source = input(container);
    const target = output(container);
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    expect(target?.value).toBe('');
    expect(target?.readOnly).toBe(true);

    // 位置断言：输出框在 DOM 顺序上位于原文输入框之后。
    const position = source.compareDocumentPosition(target as Node);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 标题与提示文案存在。
    expect(container.textContent).toContain('译文');
    expect(container.querySelector('.output-panel')).not.toBeNull();

    act(() => root.unmount());
  });

  it('流式期间显示已累积的增量并标记"输出中"', () => {
    const container = document.createElement('div');
    const root = render(container, { outputText: 'The local', outputStreaming: true });

    expect(output(container)?.value).toBe('The local');
    expect(container.textContent).toContain('输出中');
    // 流式期间不允许清空，避免把正在增长的内容清掉。
    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '清空',
    );
    expect(clearButton?.disabled).toBe(true);

    act(() => root.unmount());
  });

  it('完成后保留译文并显示"已保存到历史"与模型 id', () => {
    const container = document.createElement('div');
    const root = render(container, {
      outputText: 'The local translation service is ready.',
      outputSaved: true,
    });

    expect(output(container)?.value).toBe('The local translation service is ready.');
    expect(container.textContent).toContain('已保存到历史');
    expect(container.textContent).toContain('mock-model');
    expect(container.textContent).not.toContain('输出中');

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '清空',
    );
    expect(clearButton?.disabled).toBe(false);

    act(() => root.unmount());
  });

  it('清空按钮触发回调', () => {
    const container = document.createElement('div');
    const onClear = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <Translator
          sourceText="原文"
          sourceLang="zh"
          targetLang="en"
          onSourceTextChange={() => undefined}
          onDirectionChange={() => undefined}
          onTranslate={() => undefined}
          onCancel={() => undefined}
          translating={false}
          disabled={false}
          maxChars={10000}
          outputText="已有译文"
          outputStreaming={false}
          outputSaved={true}
          outputModelId="mock-model"
          onClearOutput={onClear}
        />,
      );
    });

    const clearButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '清空',
    );
    act(() => {
      clearButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('空译文时复制与清空都不可用', () => {
    const container = document.createElement('div');
    const root = render(container);

    const buttons = Array.from(container.querySelectorAll('.output-actions button'));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    act(() => root.unmount());
  });
});
