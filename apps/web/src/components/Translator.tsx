/** 右栏顶部：原文输入、方向切换、翻译按钮，以及输入框下方的译文输出框（DESIGN.md §9.1 / §9.4）。 */

import type { Lang } from '@ots/contracts';
import { directionLabel } from '../format';
import { OutputBox } from './OutputBox';

export interface TranslatorProps {
  sourceText: string;
  sourceLang: Lang;
  targetLang: Lang;
  onSourceTextChange: (text: string) => void;
  onDirectionChange: (sourceLang: Lang, targetLang: Lang) => void;
  onTranslate: () => void;
  onCancel: () => void;
  /** 清空原文输入框与译文输出（不影响任何记录）。 */
  onClearSource: () => void;
  /** 不翻译直接写库：把当前原文按原样存入历史。 */
  onSaveDirect: () => void | Promise<void>;
  translating: boolean;
  /** 未选合集、服务已关闭等情况下整体禁用。 */
  disabled: boolean;
  maxChars: number;
  /** 输出框要显示的译文（流式期间为已累积增量）。 */
  outputText: string;
  /** 输出框是否正在流式增长。 */
  outputStreaming: boolean;
  /** 输出框内容是否已落库。 */
  outputSaved: boolean;
  /** 输出框显示的模型 id（无结果时为 null）。 */
  outputModelId: string | null;
  /** 清空输出框（不影响历史记录）。 */
  onClearOutput: () => void;
}

export function Translator({
  sourceText,
  sourceLang,
  targetLang,
  onSourceTextChange,
  onDirectionChange,
  onTranslate,
  onCancel,
  onClearSource,
  onSaveDirect,
  translating,
  disabled,
  maxChars,
  outputText,
  outputStreaming,
  outputSaved,
  outputModelId,
  onClearOutput,
}: TranslatorProps): JSX.Element {
  const tooLong = sourceText.length > maxChars;
  const canTranslate = !disabled && !translating && !tooLong && sourceText.trim() !== '';

  const handleClearSource = (): void => {
    onClearSource();
    onClearOutput();
  };

  const handleSaveDirect = (): void => {
    void Promise.resolve(onSaveDirect()).then(onClearOutput);
  };

  return (
    <section className="panel translator">
      <div className="direction-row">
        <span className="direction-label">翻译方向</span>
        <div className="direction-toggle" role="group" aria-label="翻译方向">
          <button
            type="button"
            className={sourceLang === 'zh' ? 'dir active' : 'dir'}
            onClick={() => {
              onDirectionChange('zh', 'en');
            }}
            disabled={disabled || translating}
            aria-pressed={sourceLang === 'zh'}
          >
            中 → 英
          </button>
          <button
            type="button"
            className={sourceLang === 'en' ? 'dir active' : 'dir'}
            onClick={() => {
              onDirectionChange('en', 'zh');
            }}
            disabled={disabled || translating}
            aria-pressed={sourceLang === 'en'}
          >
            英 → 中
          </button>
        </div>
        <span className="direction-current muted">当前：{directionLabel(sourceLang, targetLang)}</span>
        {translating ? <span className="badge">翻译中…</span> : null}
      </div>

      <textarea
        className="source-input"
        value={sourceText}
        placeholder="在此输入要翻译的文本，Ctrl/⌘ + Enter 直接翻译"
        disabled={disabled}
        onChange={(event) => {
          onSourceTextChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canTranslate) {
            event.preventDefault();
            onTranslate();
          }
        }}
      />

      <div className="translator-footer">
        <span className={tooLong ? 'counter counter-over' : 'counter muted'}>
          {sourceText.length} / {maxChars} 字符
        </span>
        {tooLong ? <span className="error-text">原文超过长度上限，请缩短后再翻译</span> : null}
        <div className="translator-buttons">
          <button
            type="button"
            className="btn btn-mini"
            onClick={handleClearSource}
            disabled={disabled || sourceText === ''}
            title="清空原文输入与译文输出，不影响历史记录"
          >
            清空
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleSaveDirect}
            disabled={disabled || translating || sourceText.trim() === '' || tooLong || outputText !== ''}
            title={
              outputText !== ''
                ? '已有译文，避免重复存入历史'
                : '不翻译，把当前原文按原样直接存入当前合集的历史'
            }
          >
            直接存历史
          </button>
          {translating ? (
            <button type="button" className="btn" onClick={onCancel}>
              取消翻译
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            onClick={onTranslate}
            disabled={!canTranslate}
          >
            {translating ? '翻译中…' : '翻译'}
          </button>
        </div>
      </div>

      <OutputBox
        text={outputText}
        streaming={outputStreaming}
        saved={outputSaved}
        direction={directionLabel(sourceLang, targetLang)}
        modelId={outputModelId}
        onClear={onClearOutput}
      />
    </section>
  );
}
