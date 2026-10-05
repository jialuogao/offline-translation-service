# runtime-and-config

Startup order, configuration loading, HTTP assembly and the shutdown orchestration.
Governing design: `DESIGN.md` §3.3, §3.4, §5.4, §11.

## Startup order (verified)

`apps/server/src/index.ts` only guards the direct-run case and registers signal
handlers; `bootstrap.ts#startService()` does the wiring in this order:

1. `openDb(config.dbPath)` — creates the directory, opens the file, applies the schema.
2. `CollectionService.init()` — creates the default collection when the table is empty
   and repairs `meta.active_collection_id` (§4.2).
3. `LMStudioAdapter` + `LMStudioProcessManager.startup()` — probe, then spawn if needed.
4. `TranslationService`, `ShutdownController`, then `createApp()`.
5. `app.listen(config.port, config.host)`.
6. `shutdown.attachServer(server)` — see the Shutdown section for why it is not a
   constructor argument.

Because step 3 can block for `LMSTUDIO_STARTUP_TIMEOUT_MS`, model warm-up
(`POST /api/v1/models/load`) is deliberately **not awaited**: the UI must come up even
while a 30B model is still loading.

`startService()` deliberately does not touch `process.on(...)`, so tests can import it
without side effects. `index.ts` registers `SIGINT`/`SIGTERM`.

## Configuration

`config.ts` is the only place that reads environment variables; everything else imports
`config`. It is evaluated at import time, so tests must either set the environment
before importing it or inject options explicitly (the test harness does the latter).

- `HOST` defaults to `127.0.0.1` and must stay a loopback address: the service has no
  authentication by design (`DESIGN.md` §1.3).
- Values are validated: an invalid integer throws at startup instead of silently
  falling back.
- `NODE_ENV=test` moves the default DB under `.temp/` so a test run can never write to
  `apps/server/data/`.
- `LMSTUDIO_MODEL` defaults to a **specific** model id rather than empty. It used to be
  empty, which made model resolution fall through to "first entry of `/v1/models`" — a
  choice dictated by LM Studio's list order rather than by us. Load, warm-up and unload
  all read this one value, so switching models is a single edit.
- `LMSTUDIO_UNLOAD_TIMEOUT_MS` and `LMSTUDIO_LIST_TIMEOUT_MS` bound the two `lms`
  child processes. Exceeding either degrades (nothing is killed), so a hang in the CLI
  cannot block shutdown indefinitely.

## HTTP assembly

`http/app.ts#createApp()` is assembly plus error shaping only — no business logic.

Two ordering constraints that are easy to break:

1. **Routers are mounted at `/api` with full paths.** All five route modules declare
   paths like `/collections/active` and are mounted via `app.use('/api', router)`.
   The entries router must be registered **before** the collections router, because
   `/collections/:id` otherwise swallows `/collections/:id/entries`.
   Within the collections router, `/collections/active` is registered before
   `/collections/:id` for the same reason.
2. **Errors are shaped in exactly one place.** `HttpError` becomes
   `{ error, message }` with its status; anything else becomes a 500
   `INTERNAL_ERROR`. Malformed JSON is translated to `INVALID_JSON` by the middleware
   directly after `express.json()`.

Express 4 does not catch async handler rejections, so async handlers are wrapped with
`http/asyncHandler.ts`; without it a rejected route would hang until timeout.

When `apps/server/public/index.html` is missing, `*` returns 503 with a Chinese hint to
run `pnpm build:web` instead of a bare 404.

## Shutdown

`shutdown.ts#ShutdownController` runs one fixed sequence for **both** paths of §3.4 —
there is no longer an ownership branch, because §6.4 removed every decision that
depended on who started LM Studio:

```
unload model → stop accepting connections → close resources → grace period → exit
```

Verified details:

- The route writes `{ ok: true }` **first** and only then calls `shutdown()`, so the
  response is not lost to the exit. That response means *accepted*, not *finished*:
  the unload still runs for a couple of seconds afterwards. Callers must poll until the
  connection is refused; `shutdown.ps1` is the reference implementation of that poll.
- `attachServer()` exists because the shutdown controller must exist before `createApp()`
  is called, while the `Server` only exists after `app.listen()`. The wiring therefore
  back-fills the server after listening.
- `server.close()` is called but its callback is **never awaited**. Waiting for in-flight
  requests is pointless here: an SSE stream may never end, so shutdown would block
  indefinitely. The grace period then cuts them off.
- The exit timer must **not** be `unref()`ed. That is no longer safe precisely because
  `server.close()` was added: once nothing keeps the loop alive, an unref'd timer is
  discarded and `exit()` would never run.
- A failure while unloading the model is swallowed on purpose (§6.4) — the database still
  closes and the process still exits. A resident model is much cheaper than killing a
  process that may not be LM Studio.
- `shutdown()` is idempotent; a second call (for example SIGTERM after SIGINT) is a no-op.
- `closeResources` closes SQLite **before** the process exits, which flushes WAL.
- Exit codes: `0` via HTTP, `130` on SIGINT, `143` on SIGTERM.

The ownership-based shutdown this replaced (kill by recorded PID, `closeLmStudio`,
409 + `force`) is history; see [lmstudio-lifecycle.md](lmstudio-lifecycle.md) for why it
was abandoned.

## The backend console window closes itself (verified)

`run.ps1` starts the backend with `Start-Process pnpm.cmd start -WindowStyle Normal`, so
it runs in its own console window. Verified: after a graceful shutdown the **entire**
process chain exits and the window goes with it. The chain is six layers deep, all
parent/child:

```
cmd.exe (/c pnpm.CMD start)        <- owns the console window
 └ pnpm.exe  (pnpm start)
   └ cmd.exe  (/c pnpm --filter @ots/server start)
     └ pnpm.exe
       └ cmd.exe  (/c node dist/index.js)
         └ node.exe  dist/index.js  <- the listener
```

`node` exits → both `pnpm` layers return → the batch files end → `cmd.exe` exits → the
console host tears the window down. Nothing detaches, so nothing survives.

This is what lets `shutdown.ps1` stay a **pure HTTP wrapper**: it needs no PID file, no
window matching and no process termination of any kind. An earlier design considered
writing a PID file so the shutdown script could close the window explicitly; measuring
the chain showed that is unnecessary.

Two consequences worth remembering:

- It only holds because the backend exits **normally**. Killing the process tree by hand
  drops the window but skips the unload and the database close; pressing the window's X
  skips both.
- `run.ps1` has no switch to hide that window, by decision — for an unattended caller the
  window stays visible until the service exits. See `docs/usage.md`.

## Gotchas

- `node:sqlite` is resolved through `createRequire` in `db/sqlite.ts`; see
  [collections-and-db.md](collections-and-db.md) for why a static import breaks Vitest.
- `apps/server/dist` mirrors `src/` one-to-one (`rootDir: src`). `config.ts` resolves
  its directories from the module URL, so `dist/config.js` must stay exactly one level
  below `apps/server/`.
