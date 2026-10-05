# translation-and-sse

Prompt construction, the LM Studio client, the streaming translation service, and the
REST/SSE contracts. Governing design: `DESIGN.md` §5, §7, §9.3, §9.4.

## Layering

```
routes/translate.ts   HTTP/SSE framing, validation, in-flight guard
  services/translationService.ts   prompt, event stream, persistence on `done`
    lmstudio/adapter.ts            the only module that speaks LM Studio HTTP
      services/collectionService.ts  persistence
```

Prompt text and direction handling live **only** in `translationService.ts`; do not
scatter prompt strings elsewhere.

## REST contract

`http/app.ts` mounts all routers at `/api`. Errors are always
`{ error: "<CODE>", message: "<human>" }`:

| Situation | Status | Code |
|---|---|---|
| Body is not JSON | 400 | `INVALID_JSON` |
| Missing/invalid field, bad direction, empty text | 400 | `INVALID_REQUEST` |
| Source text over `TRANSLATE_MAX_CHARS` | 400 | `INPUT_TOO_LONG` |
| Same collection already translating | 409 | `TRANSLATION_IN_FLIGHT` |
| Concurrent stream cap reached | 409 | `TRANSLATION_IN_FLIGHT` |
| Collection or entry missing | 404 | `COLLECTION_NOT_FOUND` / `ENTRY_NOT_FOUND` |
| Unknown `/api` path | 404 | `NOT_FOUND` |
| LM Studio not started by this session, no `force` | 409 | `LMSTUDIO_NOT_OWNED` |
| Anything unexpected | 500 | `INTERNAL_ERROR` |

**`TRANSLATION_IN_FLIGHT` is a 409, not a 400** — `assertNotInFlight` uses
`conflict()`. It is thrown before any SSE header is written, so the client receives
ordinary JSON and can display `message`.

Route ordering matters: validation runs first, then `assertNotInFlight`, then the stream
limit, then the SSE headers. Reordering these turns a clean JSON error into a
half-written event stream.

## SSE contract

```
event: delta
data: {"text":"Trans"}

event: done
data: {"entry_id":"uuid","target_text":"...","model_id":"..."}
```

`error` events reuse the REST error shape. Each frame is exactly
`event: <name>\ndata: <json>\n\n` (`writeSse`); there is no `id:` and no retry hint,
because the client parses the stream by hand.

Persistence happens **only** when the accumulator is non-empty at the end of the stream
(§5.3). Nothing is written during streaming, so a mid-stream failure or a client
disconnect leaves no partial row. An empty final result becomes an
`LMSTUDIO_UNAVAILABLE` error event rather than an empty entry.

## Streaming details that were verified the hard way

### Detecting a client disconnect

`req.on('close')` is **not** a disconnect signal here. Under Node 26 + Express 4 the
request already reports `destroyed === true` and emits `close` once the body has been
read, so treating it as a disconnect cancels every request before the first delta — the
client gets HTTP 200 with an empty body. The route therefore listens on the **socket**:

```ts
const socket = req.socket;
const onSocketClose = () => {
  if (res.writableEnded) return;   // normal completion, not a disconnect
  controller.abort();
  release();
};
socket?.on('close', onSocketClose);
```

The listener is removed in `finally` before `res.end()`.

### Aborting the upstream request

`apps/server/src/lmstudio/adapter.ts#readDeltas` races each `reader.read()` against the
abort signal. Node's fetch does **not** reliably reject a pending body read when the
signal fires after the response resolved — the reader keeps waiting on the socket. The
race cancels the underlying stream and rejects with an `AbortError` shaped from
`signal.reason`, which `translateStream` recognizes:

- if the signal is aborted (or the error is an `AbortError`), the generator returns
  silently and **nothing is persisted**;
- any other error becomes a single `error` event.

`adapter.request()` also forwards the caller's signal into its own timeout controller,
so the per-request timeout and cancellation compose.

### SSE parsing

`readDeltas` buffers bytes as text, splits on `\n`, tolerates `\r`, ignores comment lines
(`:`) and blank lines, and stops on `data: [DONE]`. A single unparsable JSON line is
skipped rather than fatal — real endpoints may emit keep-alives or partial frames.

`chatCompletion()` validates the HTTP status **before** returning, so
`await adapter.chatCompletion(...)` throws for a 503 while mid-stream failures surface
when the `deltas` iterator is consumed. Both map to `LMSTUDIO_UNAVAILABLE`.

## Concurrency (§9.4)

- `TranslationService` keeps a `Set` of collection ids currently in flight; the entry is
  added before the first await and removed in `finally`, so the guard covers errors,
  aborts and early generator return (`for await ... break` triggers `return`).
- Distinct collections stream concurrently.
- The route additionally caps total concurrent streams at `MAX_CONCURRENT_STREAMS`
  (default 4) and releases the slot exactly once (guarded by a `counted` flag, because
  both the socket handler and the route's `finally` can run).
- Reaching the cap returns `TRANSLATION_IN_FLIGHT` (409) before writing SSE headers.

## Adapter options and test-only headers

`ChatStreamOptions` supports `extraHeaders` and `query`. `TranslationService` fills them
from `OTS_TEST_MOCK_HEADERS` / `OTS_TEST_MOCK_QUERY` (read at call time, so a test can
change them mid-run) and, when `LMSTUDIO_MOCK_HEADERS=true` is set, adds
`X-Mock-Source-Lang`. All three are **off by default**, so production traffic never
carries mock-only headers. This is how §8.2's fault injection (`mock_fail=...`) reaches
the mock without adding a test-only API to the service.

## Prompt

`buildTranslatePrompt()` renders §7.1's template with `Chinese`/`English` for `zh`/`en`,
`temperature: 0.3`, and the source text as a single user message. Model selection is
`explicit > LMSTUDIO_MODEL > first model from /v1/models` and is resolved inside the
adapter (`resolveModel`).

`GET /api/lmstudio/models` and `/status` are covered in
[lmstudio-lifecycle.md](lmstudio-lifecycle.md).
