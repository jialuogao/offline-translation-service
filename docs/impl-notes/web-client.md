# web-client

The React SPA in `apps/web/`. Governing design: `DESIGN.md` §9. All user-visible text is
Chinese; styling is plain CSS (`src/styles.css`) with no UI framework and no extra
runtime dependency beyond React and `@ots/contracts`.

## Layout and files

```
src/
  main.tsx            mounts App into #root, imports styles.css
  App.tsx             composition: data hooks, dialogs, banners, lifecycle actions
  api/client.ts       fetch wrapper; parses { error, message } into ApiError
  api/translate.ts    POST + ReadableStream SSE parser
  hooks/              useCollections, useEntries, useMultiSelect, useLmStudioStatus, useTranslator
  components/         CollectionList, Translator, HistoryList, StatusBar, ConfirmDialog
  format.ts           local time and direction labels
```

Two columns: collections on the left, translator plus history on the right, with a
status bar carrying the LM Studio state and the shutdown actions.

## POST SSE parsing (`api/translate.ts`)

`EventSource` cannot be used — the endpoint needs POST. The parser reads the response
body with a reader, decodes incrementally, buffers until a blank-line terminator
(accepting both `\n\n` and `\r\n\r\n`), ignores `:` comment lines, joins multiple `data:`
lines with `\n`, and dispatches on `event:`. A frame split across two network chunks is
therefore handled correctly; this was verified against a real server that deliberately
splits JSON mid-frame.

- `delta` payloads are **incremental** and are concatenated.
- `done` finalizes the row and triggers a refresh of page 1 plus the collection counts.
- `error` throws an `ApiError` carrying the server's Chinese `message`.
- Non-2xx responses are parsed as JSON errors, with a `请求失败（HTTP <status>）`
  fallback when the body is not JSON.

## Multi-select semantics (§9.2)

Implemented in `hooks/useMultiSelect.ts`; the semantics are the contract, not an
implementation detail:

| Gesture | Result |
|---|---|
| Checkbox click | Selects only that row and moves the anchor; clicking an already-selected row's checkbox deselects it |
| Plain row click | Anchor moves to that row; only that row is selected |
| Ctrl/Cmd + click | Toggles just that row (non-contiguous selection); the anchor moves there |
| Shift + click | Adds the inclusive range from the anchor to the clicked row; the anchor is preserved; falls back to single-select when no anchor exists |
| Header checkbox, and Ctrl/Cmd+A while the list has focus | Select-all / clear-all **of the current page only** |
| `Delete` while the list has focus | Same as 批量删除 |

Supporting rules:

- `Ctrl/Cmd+A` never hijacks the shortcut while focus is in an input or textarea
  (`tagName`/`isContentEditable` check).
- A row click that follows a text selection inside the row is ignored
  (`window.getSelection()` non-collapsed check).
- Selected ids that are no longer on the page are dropped by an effect on `pageIds`, so
  a stale id can never reach `batch-delete`. Changing pages clears the selection.
- The action bar shows `已选 N 条` with 批量删除 / 取消选择, and batch delete asks for
  confirmation first.

`useMultiSelect` keeps `anchorIndex` (an index into the current page), not a row id,
because Shift ranges are page-relative.

## UI preferences (remembered settings)

Anything that is a pure interface choice — not user content — is persisted in
`localStorage` under versioned keys (`ots:pref:v1:<name>`, see
`apps/web/src/preferences.ts`):

| Preference | Key | Notes |
|---|---|---|
| Translation direction (`zh`/`en`) | `source-lang` | Restored by `usePersistentEnum`; App defaults to `zh` |
| History page size (`20/50/100/200`) | `entries-page-size` | Restored by `usePersistentNumber`; drives the 每页 selector in the history header |

Rules that keep this safe and unsurprising:

- **Storage failures are never fatal.** `localStorage` may be absent, blocked by policy,
  or full; every read falls back to the default and every write swallows the error, so the
  page still works. `loadEnum`/`loadNumber` validate against an allow-list, so a corrupt or
  stale value degrades to the default instead of rendering something bogus.
- **The key prefix carries a version.** Changing a preference's shape means bumping
  `PREFIX`; old values are then simply ignored rather than misparsed.
- **Skip the first-frame write.** The restore happens in an effect after mount (so it never
  blocks first paint), which means the first persist-write must be skipped — otherwise the
  default value would overwrite the stored one. Both hooks track this with a `mounted` ref;
  `tests/ui/preferences-hooks.test.tsx` has an explicit regression test for it.
- **What is deliberately NOT stored:** source text, the output box content, the streaming
  state, and selection. The output box and source text are user content, and the translation
  itself is already durably stored server-side.

### Page-size effect in `useEntries`

`useEntries(collectionId, pageSize, onError)` takes the page size as a prop instead of a
constant, so the preference drives pagination. `ENTRIES_PAGE_SIZE` (50) is only the
default, and `ENTRIES_PAGE_SIZE_OPTIONS` is the allow-list shared with the preference.

Three behaviours that are easy to break in this effect and are therefore deliberate:

- The effect is keyed on `[collectionId, pageSize, load]` and every run reloads **page 1**,
  because a changed collection or page size makes the old page number meaningless. `page`
  is read for the "is a reset needed?" decision but is **not** in the dependency list —
  adding it would turn every `setPage` into a second fetch.
- The previous-page-size comparison happens **before** `pageSizeRef` is updated. Comparing
  after the assignment makes the condition always false, so a page-size change would never
  reset the page.
- The pref hydration path (`usePersistentNumber` swapping the default for the stored value
  right after mount) must not cause a duplicate first fetch; that is the reason the effect
  is not keyed on `pageSize` alone.

`onError` is held in a ref so a new callback identity cannot trigger a refetch, and
`load` takes an explicit `pageSize` argument so it has an empty dependency list.

Regression tests: `tests/ui/preferences-hooks.test.tsx` covers hydration semantics, and the
page-size request path is asserted end to end by `tests/server/api.test.ts`
(`pageSize=20`/`200` honoured, junk falls back to 50 via `§5.2 分页参数非法时回退到默认值`).

### Active collection across reloads

The backend already persists the active collection (`meta.active_collection_id`,
`DESIGN.md` §4.1), so in the common case a reload lands on the same collection with no help
from the browser. The client additionally remembers the id it last selected
(`active-collection`) purely to survive the case where **another window or client switched
the collection on the server**: on load, `App` compares the two and issues one switch only
when they differ. Cancellation rules:

- Once the user clicks a collection in this page, the restore never runs
  (`userPickedCollectionRef`), so a slow load cannot yank the selection back.
- The restore runs at most once per page load (`restoredRef`).
- If the remembered collection no longer exists, it is ignored **and the stale id is
  deleted** from storage.
- When the server's active already matches, no `PUT /api/collections/active` is sent.

Regression tests: `tests/ui/app-preferences.test.tsx` (direction survives remount; matching
active sends no PUT; mismatched active restores it; deleted collection is ignored and
forgotten; clicking a collection writes the memory) and `tests/ui/preferences.test.ts`
(validation, versioning, fault tolerance).

## Translation behaviour

- One in-flight request per collection: while it is running, the translate button and
  direction switch are disabled and new clicks are ignored (not queued). The backend
  enforces the same rule with 409 `TRANSLATION_IN_FLIGHT`.
- **The output box below the input (`components/OutputBox.tsx`) is the primary place the
  translation is read.** During streaming it shows the accumulated deltas; after `done`
  it keeps the final text and adds a 已保存到历史 badge plus the model id. It has 复制 /
  清空 actions; 清空 only clears the box and never touches history.
- The streaming row in the history list still exists (newest row, grows as deltas
  arrive), so the same translation is visible in two places by design: the box for
  reading/copying, the history row for the record.
- `error` shows the Chinese `message` and persists nothing; the partial text stays in the
  output box so the user can see what arrived.
- Whitespace-only input is a no-op. `TRANSLATE_MAX_CHARS` is mirrored client-side for
  instant feedback only; the server is authoritative.

### `useTranslator` state contract

Two pieces of state feed the box, and the distinction matters:

| State | Lifetime | Meaning |
|---|---|---|
| `live` | from request start until `done` (or cancel/error) | In-flight, possibly partial text |
| `lastResult` | from `done` until `dismissResult()` | Committed translation that is already persisted |

`done` sets `lastResult` and clears `live` **inside the hook**. Do not move that cleanup
into the caller's `onDone`: the two states would then overlap, and a consumer could not
tell "still streaming" from "finished" without duplicating the bookkeeping. Both carry a
`collectionId`, and `App` only shows the one matching the active collection, so switching
collections never leaks another collection's text into the box.

Regression tests: `tests/ui/useTranslator.test.tsx` (state flow: accumulation, `done`
produces `lastResult`, disconnect and error produce none, cancel, ignore-while-in-flight,
`dismissResult`, per-collection attribution) and `tests/ui/translator.test.tsx` (render:
the box sits **after** the source textarea, read-only, empty on first render, disabled
actions when empty, 输出中 vs 已保存到历史 states).

## Lifecycle UI

`StatusBar` shows 运行中 / 未就绪, `startedByUs`, the loaded model and the PID, with
刷新 and 重试 actions.

- **关闭服务** first reads `/api/lmstudio/status`. `startedByUs === true` →
  `POST /api/shutdown` with no prompt. `startedByUs === false` → a dialog asking
  是否同时关闭 LM Studio, then `POST /api/shutdown` with `{ closeLmStudio: true | false }`
  (the dialog also offers 仅关闭服务).
- **仅关闭 LM Studio** posts to `/api/lmstudio/shutdown`; on 409 `LMSTUDIO_NOT_OWNED` it
  asks for confirmation and retries with `{ force: true }`.
- After a successful shutdown the UI switches to a 服务已关闭 banner, disables controls
  and stops polling; there is no way to restart the backend from the page. A network
  failure on any request is treated the same way (backend presumed gone).

## Build integration

`vite.config.ts` writes the production bundle into `apps/server/public`, which the
Express app serves (see [runtime-and-config.md](runtime-and-config.md)). The dev server
runs on 5173 and proxies `/api` to `http://127.0.0.1:5174` (override with
`OTS_API_TARGET`). `apps/server/public` is a build artifact and must not be edited by
hand or deleted after a build.
