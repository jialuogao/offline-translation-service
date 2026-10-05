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

`shutdown.ts#ShutdownController` implements both paths of §3.4:

| Path | `startedByUs=true` | `startedByUs=false` |
|---|---|---|
| `POST /api/shutdown` | kill by recorded PID; `closeLmStudio` is ignored | `closeLmStudio=true` → best-effort kill by port PID; otherwise leave LM Studio alone |
| `SIGINT`/`SIGTERM` | kill by recorded PID | never touch LM Studio |

Verified details:

- The route writes `{ ok: true }` first and only then calls `shutdown()`, so the
  response is not lost to the exit. The controller waits `gracePeriodMs` (150 ms in
  production, 0 in tests) before invoking `exit`.
- A failure while closing LM Studio is swallowed on purpose (§6.4) — the database still
  closes and the process still exits.
- `shutdown()` is idempotent; a second call (for example SIGTERM after SIGINT) is a no-op.
- `closeResources` closes SQLite **before** the process exits, which flushes WAL.

## Gotchas

- `node:sqlite` is resolved through `createRequire` in `db/sqlite.ts`; see
  [collections-and-db.md](collections-and-db.md) for why a static import breaks Vitest.
- `apps/server/dist` mirrors `src/` one-to-one (`rootDir: src`). `config.ts` resolves
  its directories from the module URL, so `dist/config.js` must stay exactly one level
  below `apps/server/`.
