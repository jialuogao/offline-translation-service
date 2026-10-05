import type { Lang } from '@ots/contracts';
import { config } from '../config.js';
import { ErrorCode, badRequest, conflict } from '../errors.js';
import type { CollectionService } from './collectionService.js';
import type { ChatMessage, LMStudioAdapter } from '../lmstudio/adapter.js';
import { LMStudioError } from '../lmstudio/adapter.js';

/**
 * 翻译业务（DESIGN.md §3.2 / §5.3 / §7）。
 *
 * 职责：构造 prompt、调 adapter 流式推理、产出 `delta`/`done`/`error` 事件流。
 * 落库只发生在流结束（`done`）那一刻，流式期间不写库（§5.3）。
 */

export type LangName = 'Chinese' | 'English';

export type TranslationEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; entry_id: string; target_text: string; model_id: string | null }
  | { type: 'error'; code: string; message: string };

export interface TranslateStreamOptions {
  collectionId: string;
  sourceLang: Lang;
  targetLang: Lang;
  sourceText: string;
  signal?: AbortSignal;
}

/**
 * 测试用的上游请求注入（DESIGN.md §8.2 的错误注入）。
 *
 * 只在显式设置了环境变量时生效；生产运行不读它，也不需要为了测试增加一条 API。
 * 刻意在调用时读环境变量（而不是 import 时求值），测试可在同一进程内切换注入。
 */
function testInjection(): {
  extraHeaders?: Record<string, string>;
  query?: Record<string, string>;
} {
  const injection: {
    extraHeaders?: Record<string, string>;
    query?: Record<string, string>;
  } = {};
  const query = parsePairs(process.env.OTS_TEST_MOCK_QUERY ?? '');
  if (query !== undefined) injection.query = query;
  const headers = parsePairs(process.env.OTS_TEST_MOCK_HEADERS ?? '');
  if (headers !== undefined) injection.extraHeaders = headers;
  return injection;
}

function parsePairs(raw: string): Record<string, string> | undefined {
  if (raw === '') return undefined;
  const parsed: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    const separator = pair.indexOf('=');
    const key = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? '' : pair.slice(separator + 1);
    if (key !== '') parsed[key] = value;
  }
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

/** §7.1 prompt 模板；翻译方向与模板只在此维护。 */
const SYSTEM_PROMPT_TEMPLATE = `You are a professional translator. Translate the user's text from {source_lang_name} to {target_lang_name}.

Rules:
- Output only the translation, with no explanations, no quotes, no extra commentary.
- Preserve formatting, code blocks, URLs, and proper nouns as-is unless they are clearly part of the translatable text.
- If the input is already in the target language, output it unchanged.`;

const LANG_NAMES: Record<Lang, LangName> = { zh: 'Chinese', en: 'English' };

export function langName(lang: Lang): LangName {
  return LANG_NAMES[lang];
}

export function isLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en';
}

export function buildTranslatePrompt(
  sourceLang: Lang,
  targetLang: Lang,
  sourceText: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: SYSTEM_PROMPT_TEMPLATE.replace('{source_lang_name}', langName(sourceLang)).replace(
        '{target_lang_name}',
        langName(targetLang),
      ),
    },
    { role: 'user', content: sourceText },
  ];
}

export class TranslationService {
  /** 同一合集同一时刻只允许一个在飞翻译（DESIGN.md §9.4）。 */
  private readonly inFlight = new Set<string>();
  private readonly maxChars: number;
  /** 是否附带 `X-Mock-Source-Lang` 头（仅测试；DESIGN.md §8.2）。 */
  private readonly mockHeaders: boolean;

  constructor(
    private readonly adapter: LMStudioAdapter,
    private readonly collections: CollectionService,
    options: { maxChars?: number; mockHeaders?: boolean } = {},
  ) {
    this.maxChars = options.maxChars ?? config.translateMaxChars;
    this.mockHeaders = options.mockHeaders ?? config.mockHeaders;
  }

  isInFlight(collectionId: string): boolean {
    return this.inFlight.has(collectionId);
  }

  /** 同一合集已有在飞请求时抛 409 `TRANSLATION_IN_FLIGHT`（§9.4）。 */
  assertNotInFlight(collectionId: string): void {
    if (this.inFlight.has(collectionId)) {
      throw conflict(ErrorCode.translationInFlight, '该合集已有翻译正在进行中，请稍后再试');
    }
  }

  validate(req: {
    collectionId: string;
    sourceLang: unknown;
    targetLang: unknown;
    sourceText: unknown;
  }): asserts req is { collectionId: string; sourceLang: Lang; targetLang: Lang; sourceText: string } {
    if (!isLang(req.sourceLang) || !isLang(req.targetLang)) {
      throw badRequest(ErrorCode.invalidRequest, 'source_lang / target_lang 只能是 zh 或 en');
    }
    if (req.sourceLang === req.targetLang) {
      throw badRequest(ErrorCode.invalidRequest, '源语言与目标语言不能相同');
    }
    if (typeof req.sourceText !== 'string' || req.sourceText.trim() === '') {
      throw badRequest(ErrorCode.invalidRequest, 'source_text 不能为空');
    }
    if (req.sourceText.length > this.maxChars) {
      throw badRequest(
        ErrorCode.inputTooLong,
        `原文超过上限：${req.sourceText.length} > ${this.maxChars} 字符`,
      );
    }
    this.collections.getOrThrow(req.collectionId);
  }

  /**
   * 流式翻译。事件序列：若干 `delta` → `done`；任何失败替换为单个 `error`，
   * 并且不写库（§5.3 / §8.3）。
   */
  async *translateStream(req: TranslateStreamOptions): AsyncGenerator<TranslationEvent, void, undefined> {
    const { collectionId, sourceLang, targetLang, sourceText, signal } = req;
    this.inFlight.add(collectionId);
    try {
      const messages = buildTranslatePrompt(sourceLang, targetLang, sourceText);
      let accumulated = '';
      let modelId: string | null = null;

      try {
        const stream = await this.adapter.chatCompletion({
          messages,
          temperature: 0.3,
          signal,
          // 仅测试流量附带 Mock 方向头（DESIGN.md §8.2），默认关闭。
          ...testInjection(),
          ...(this.mockHeaders ? { extraHeaders: { 'X-Mock-Source-Lang': sourceLang } } : {}),
        });
        modelId = stream.model;
        for await (const delta of stream.deltas) {
          accumulated += delta;
          yield { type: 'delta', text: delta };
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) {
          // 客户端断开：取消上游请求，不落库（§9.4）。
          return;
        }
        yield toErrorEvent(error);
        return;
      }

      if (accumulated.trim() === '') {
        yield {
          type: 'error',
          code: ErrorCode.lmstudioUnavailable,
          message: 'LM Studio 未返回任何译文内容',
        };
        return;
      }

      const entry = this.collections.insertEntry({
        collectionId,
        sourceLang,
        targetLang,
        sourceText,
        targetText: accumulated,
        modelId,
      });
      yield {
        type: 'done',
        entry_id: entry.id,
        target_text: accumulated,
        model_id: modelId,
      };
    } finally {
      // 正常结束、出错、客户端断连（generator return）都会释放占用。
      this.inFlight.delete(collectionId);
    }
  }
}

function toErrorEvent(error: unknown): TranslationEvent {
  if (error instanceof LMStudioError) {
    return { type: 'error', code: error.code, message: error.message };
  }
  if (isAbortError(error)) {
    return { type: 'error', code: ErrorCode.lmstudioUnavailable, message: '请求已取消' };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', code: ErrorCode.lmstudioUnavailable, message };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
