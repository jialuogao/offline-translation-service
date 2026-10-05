/**
 * 应用根组件：装配合集、历史、翻译与 LM Studio 生命周期（DESIGN.md §9）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Lang } from '@ots/contracts';
import { errorMessage } from './api/client';
import {
  PREF_ACTIVE_COLLECTION,
  PREF_ENTRIES_PAGE_SIZE,
  PREF_SOURCE_LANG,
  clearRaw,
  loadRaw,
  saveRaw,
} from './preferences';
import { CollectionList } from './components/CollectionList';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { HistoryList, type StreamingRow } from './components/HistoryList';
import { StatusBar } from './components/StatusBar';
import { Translator } from './components/Translator';
import { useCollections } from './hooks/useCollections';
import { ENTRIES_PAGE_SIZE, ENTRIES_PAGE_SIZE_OPTIONS, useEntries } from './hooks/useEntries';
import { useLmStudioStatus } from './hooks/useLmStudioStatus';
import { useMultiSelect } from './hooks/useMultiSelect';
import { usePersistentEnum } from './hooks/usePersistentEnum';
import { usePersistentNumber } from './hooks/usePersistentNumber';
import { useTranslator } from './hooks/useTranslator';

/** 与后端 TRANSLATE_MAX_CHARS 默认值一致（DESIGN.md §11），用于本地即时校验。 */
const MAX_CHARS = 10000;

/** 翻译方向的合法取值，同时用于偏好校验。 */
const LANG_VALUES = ['zh', 'en'] as const satisfies readonly Lang[];

/** 带错误码的异常（ApiError 的公共形状），用于识别 409 LMSTUDIO_NOT_OWNED。 */
interface CodedError {
  code: string;
}

function isCodedError(value: unknown): value is CodedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string'
  );
}

export function App(): JSX.Element {
  const [sourceText, setSourceText] = useState('');
  // 翻译方向是纯界面偏好，记在 localStorage 里，刷新/重开页面后仍是上次的选择。
  const [sourceLang, setSourceLang] = usePersistentEnum<Lang>(
    PREF_SOURCE_LANG,
    LANG_VALUES,
    'zh',
  );
  const [banner, setBanner] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ConfirmRequest | null>(null);

  const showError = useCallback((message: string): void => {
    setBanner(message);
  }, []);

  const lmstudio = useLmStudioStatus();
  const collections = useCollections(showError);
  // 历史每页条数也是界面偏好，刷新后保持。
  const [entriesPageSize, setEntriesPageSize] = usePersistentNumber(
    PREF_ENTRIES_PAGE_SIZE,
    ENTRIES_PAGE_SIZE_OPTIONS,
    ENTRIES_PAGE_SIZE,
  );
  const entries = useEntries(collections.active?.id ?? null, entriesPageSize, showError);

  const pageIds = useMemo(() => entries.items.map((entry) => entry.id), [entries.items]);
  const selection = useMultiSelect(pageIds);
  const translator = useTranslator();

  const activeCollection = collections.active;
  const targetLang: Lang = sourceLang === 'zh' ? 'en' : 'zh';

  /*
   * 恢复"上次选中的合集"。
   *
   * 后端的 active 合集本来就存在数据库里，所以多数情况下列表加载出来就已经是上次那个；
   * 只有服务端被别人切过（例如另开一个窗口）时，这里才补一次切换，让本浏览器回到你
   * 上次的选择。用户一旦自己点过合集，就不再自动切换。
   */
  const userPickedCollectionRef = useRef(false);
  const restoredRef = useRef(false);
  const activeCollectionId = activeCollection?.id ?? null;

  useEffect(() => {
    if (restoredRef.current || userPickedCollectionRef.current) return;
    if (collections.collections.length === 0 || activeCollectionId === null) return;
    restoredRef.current = true;

    const stored = loadRaw(PREF_ACTIVE_COLLECTION);
    if (stored === null || stored === activeCollectionId) return;
    // 记住的合集可能已被删除：不存在就忽略，并清掉这个失效值。
    if (!collections.collections.some((item) => item.id === stored)) {
      clearRaw(PREF_ACTIVE_COLLECTION);
      return;
    }
    void collections.select(stored);
  }, [activeCollectionId, collections]);

  const selectCollection = useCallback(
    (id: string): void => {
      userPickedCollectionRef.current = true;
      saveRaw(PREF_ACTIVE_COLLECTION, id);
      void collections.select(id);
    },
    [collections],
  );

  const serviceDown = lmstudio.serviceDown || collections.error !== null || entries.error !== null;
  const activeEntriesLoading = entries.loading && activeCollection !== null;
  const translating = activeCollection !== null && translator.translatingFor(activeCollection.id);

  const streamingRow: StreamingRow | null =
    translator.live !== null &&
    activeCollection !== null &&
    translator.live.collectionId === activeCollection.id
      ? {
          sourceText: translator.live.sourceText,
          targetText: translator.live.targetText,
          sourceLang: translator.live.sourceLang,
          targetLang: translator.live.targetLang,
          startedAt: translator.live.startedAt,
        }
      : null;

  const runDialogAction = useCallback(async (): Promise<void> => {
    const current = dialog;
    if (current === null) {
      return;
    }
    setDialog(null);
    setBusyAction(current.busyKey);
    try {
      await current.action();
    } catch (err) {
      setBanner(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }, [dialog]);

  const runDialogSecondary = useCallback(async (): Promise<void> => {
    const secondary = dialog?.secondary;
    if (secondary === undefined) {
      return;
    }
    setDialog(null);
    setBusyAction('dialog-secondary');
    try {
      await secondary.action();
    } catch (err) {
      setBanner(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }, [dialog]);

  const handleTranslate = useCallback((): void => {
    const collection = collections.active;
    if (collection === null || translator.translatingFor(collection.id)) {
      return;
    }
    const text = sourceText.trim();
    if (text === '') {
      // 空输入或纯空白：什么都不做（§9 要求）。
      return;
    }
    void translator.run(
      {
        collection_id: collection.id,
        source_lang: sourceLang,
        target_lang: sourceLang === 'zh' ? 'en' : 'zh',
        source_text: text,
      },
      async () => {
        // done 后固化历史行：以服务端数据刷新第一页与合集计数。live 由 useTranslator
        // 在 done 时自行收起，输出框内容也已写入 lastResult，不依赖这里。
        await entries.refresh();
        await collections.reload();
      },
    );
  }, [collections, entries, sourceLang, sourceText, translator]);

  const handleBatchDelete = useCallback((): void => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) {
      return;
    }
    setDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${ids.length} 条翻译记录吗？该操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
      busyKey: 'batch-delete',
      action: async () => {
        await entries.batchDelete(ids);
        selection.clear();
      },
    });
  }, [entries, selection]);

  const handleClearCollection = useCallback((): void => {
    const collection = collections.active;
    if (collection === null) {
      return;
    }
    setDialog({
      title: '清空合集',
      message: `确定要清空合集「${collection.name}」中的全部 ${entries.total} 条记录吗？合集本身会保留。`,
      confirmLabel: '清空',
      danger: true,
      busyKey: 'clear-collection',
      action: async () => {
        await entries.clearCollection();
        selection.clear();
      },
    });
  }, [collections.active, entries, selection]);

  const handleShutdownLmStudio = useCallback((): void => {
    setBusyAction('lmstudio');
    void (async () => {
      try {
        await lmstudio.shutdownLmStudio(false);
        setBanner('LM Studio 已关闭。历史记录仍可浏览，需要翻译时请重新启动它。');
      } catch (err) {
        if (isCodedError(err) && err.code === 'LMSTUDIO_NOT_OWNED') {
          setDialog({
            title: '关闭 LM Studio',
            message: '该 LM Studio 不是本服务启动的。是否仍要尽力关闭它？',
            confirmLabel: '仍要关闭',
            danger: true,
            busyKey: 'lmstudio-force',
            action: async () => {
              await lmstudio.shutdownLmStudio(true);
              setBanner('已尝试关闭外部 LM Studio。');
            },
          });
        } else {
          setBanner(errorMessage(err));
        }
      } finally {
        setBusyAction(null);
      }
    })();
  }, [lmstudio]);

  const handleShutdownService = useCallback((): void => {
    setBusyAction('service');
    void (async () => {
      try {
        // 关闭前先读一次状态，据此决定是否询问是否同时关闭 LM Studio（§5.4）。
        await lmstudio.refresh();
        if (lmstudio.status !== null && !lmstudio.status.startedByUs) {
          setDialog({
            title: '关闭服务',
            message: 'LM Studio 不是本服务启动的，是否同时关闭 LM Studio？',
            confirmLabel: '同时关闭',
            busyKey: 'shutdown-with-lmstudio',
            action: async () => {
              await lmstudio.shutdownService(true);
            },
            secondary: {
              label: '仅关闭服务',
              action: async () => {
                await lmstudio.shutdownService(false);
              },
            },
          });
          return;
        }
        // startedByUs === true 时后端会自行按 PID 关闭 LM Studio，无需询问。
        await lmstudio.shutdownService(false);
      } catch (err) {
        setBanner(errorMessage(err));
      } finally {
        setBusyAction(null);
      }
    })();
  }, [lmstudio]);

  const disabled = activeCollection === null || serviceDown;

  /*
   * 输出框内容：本合集正在流式输出时显示实时增量；否则显示该合集最近一次完成的译文。
   * 两者都按 collectionId 归属，切合集时输出框跟着切换，不会串台。
   */
  const liveForActive =
    translator.live !== null &&
    activeCollection !== null &&
    translator.live.collectionId === activeCollection.id
      ? translator.live
      : null;
  const resultForActive =
    translator.lastResult !== null &&
    activeCollection !== null &&
    translator.lastResult.collectionId === activeCollection.id
      ? translator.lastResult
      : null;

  const outputText = liveForActive?.targetText ?? resultForActive?.targetText ?? '';
  const outputStreaming = liveForActive !== null;
  const outputSaved = liveForActive === null && resultForActive !== null;
  const outputModelId = resultForActive?.modelId ?? null;

  return (
    <div className="app">
      <StatusBar
        status={lmstudio.status}
        loading={lmstudio.loading}
        error={lmstudio.error}
        serviceDown={lmstudio.serviceDown}
        busyAction={busyAction}
        onRefresh={() => {
          void lmstudio.refresh();
        }}
        onShutdownLmStudio={handleShutdownLmStudio}
        onShutdownService={handleShutdownService}
      />

      {banner !== null ? (
        <div className="banner banner-error">
          <span>{banner}</span>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              setBanner(null);
            }}
          >
            知道了
          </button>
        </div>
      ) : null}

      {serviceDown ? (
        <div className="banner banner-down">
          <strong>服务已关闭。</strong>
          <span>
            已经无法连接后端，历史记录与翻译都不可用；如需继续使用，请重新启动本服务（重新运行启动命令即可）。
          </span>
        </div>
      ) : null}

      <main className="layout">
        <CollectionList
          collections={collections.collections}
          activeId={activeCollection?.id ?? null}
          loading={collections.loading}
          busy={busyAction !== null}
          onSelect={selectCollection}
          onCreate={(name) => {
            void collections.create(name);
          }}
          onRename={(id, name) => {
            void collections.rename(id, name);
          }}
          onDelete={(collection) => {
            setDialog({
              title: '删除合集',
              message: `确定要删除合集「${collection.name}」及其 ${collection.entry_count} 条翻译记录吗？该操作不可撤销。`,
              confirmLabel: '删除',
              danger: true,
              busyKey: 'delete-collection',
              action: async () => {
                await collections.remove(collection.id);
                selection.clear();
              },
            });
          }}
        />

        <div className="main-column">
          <Translator
            sourceText={sourceText}
            sourceLang={sourceLang}
            targetLang={targetLang}
            onSourceTextChange={setSourceText}
            onDirectionChange={(nextSource) => {
              setSourceLang(nextSource);
            }}
            onTranslate={handleTranslate}
            onCancel={translator.cancel}
            translating={translating}
            disabled={disabled}
            maxChars={MAX_CHARS}
            outputText={outputText}
            outputStreaming={outputStreaming}
            outputSaved={outputSaved}
            outputModelId={outputModelId}
            onClearOutput={translator.dismissResult}
          />

          {activeCollection === null ? (
            <p className="state">左侧还没有可用的合集，请先新建或选择一个合集。</p>
          ) : (
            <HistoryList
              entries={entries.items}
              streaming={streamingRow}
              loading={activeEntriesLoading}
              error={entries.error}
              page={entries.page}
              pageCount={entries.pageCount}
              total={entries.total}
              pageSize={entries.pageSize}
              pageSizeOptions={ENTRIES_PAGE_SIZE_OPTIONS}
              onPageSizeChange={(next) => {
                setEntriesPageSize(next);
                entries.setPageSize(next);
              }}
              selection={selection}
              onRefresh={() => {
                void entries.refresh();
              }}
              onDeleteEntry={(id) => {
                void entries.deleteEntry(id);
              }}
              onBatchDelete={handleBatchDelete}
              onClearCollection={handleClearCollection}
              onPageChange={entries.setPage}
            />
          )}

          {translator.error !== null ? (
            <div className="banner banner-error">
              <span>翻译失败：{translator.error}</span>
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => {
                  translator.dismissError();
                }}
              >
                知道了
              </button>
            </div>
          ) : null}
        </div>
      </main>

      {dialog !== null ? (
        <ConfirmDialog
          request={dialog}
          pending={busyAction !== null}
          onConfirm={() => {
            void runDialogAction();
          }}
          onSecondary={() => {
            void runDialogSecondary();
          }}
          onCancel={() => {
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
