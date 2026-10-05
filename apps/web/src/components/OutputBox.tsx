/**
 * 译文输出框：显示最近一次翻译的结果，流式期间实时增长（DESIGN.md §9.1 / §9.3）。
 *
 * 与历史列表里的"正在翻译"行是两条展示路径，但共用同一份状态：这里只负责把结果
 * 呈现在输入框下方，方便直接阅读与复制；落库仍只发生在 done 时（§5.3）。
 */

import { useState } from 'react';

export interface OutputBoxProps {
  /** 要显示的译文（流式期间为已累积的增量）。 */
  text: string;
  /** 是否正在流式输出。 */
  streaming: boolean;
  /** 是否已经成功落库（用于展示"已保存"）。 */
  saved: boolean;
  /** 方向标签，如 "中 → 英"。 */
  direction: string;
  /** 使用的模型 id，仅在有结果时展示。 */
  modelId?: string | null;
  /** 清空输出框（只影响显示，不删除历史记录）。 */
  onClear: () => void;
}

export function OutputBox({
  text,
  streaming,
  saved,
  direction,
  modelId,
  onClear,
}: OutputBoxProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const hasText = text !== '';

  const handleCopy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // 剪贴板不可用（非安全上下文等）时退化为选中文本，至少让用户能手动复制。
        const node = document.getElementById('translation-output') as HTMLTextAreaElement | null;
        node?.select();
      }
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1500);
    })();
  };

  return (
    <section className="panel output-panel" aria-label="译文输出">
      <div className="output-header">
        <span className="output-title">译文</span>
        <span className="direction-current muted">{direction}</span>
        {streaming ? <span className="badge">输出中…</span> : null}
        {!streaming && saved ? <span className="badge badge-ok">已保存到历史</span> : null}
        {modelId !== undefined && modelId !== null && modelId !== '' ? (
          <span className="muted output-model">{modelId}</span>
        ) : null}
        <div className="output-actions">
          <button
            type="button"
            className="btn btn-mini"
            onClick={handleCopy}
            disabled={!hasText}
            title="复制译文"
          >
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              onClear();
            }}
            disabled={!hasText || streaming}
            title="只清空输出框，不影响历史记录"
          >
            清空
          </button>
        </div>
      </div>

      <textarea
        id="translation-output"
        className="output-text"
        value={text}
        readOnly
        spellCheck={false}
        placeholder={
          streaming ? '正在输出…' : '译文会显示在这里；也可以直接在下方历史列表里复制。'
        }
      />
    </section>
  );
}
