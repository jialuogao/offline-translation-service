# testing-and-mock

The mock LM Studio, the test harness, and how to run the suites. Governing design:
`DESIGN.md` §8.3; repository rules: `AGENTS.md` ("Tests and verification").

## Two suites, never run together

| Suite | Command | Config | External dependencies |
|---|---|---|---|
| Mock regression (default) | `pnpm test` | `vitest.config.ts` | none — no node, no network, no model |
| Real-model E2E | `pnpm test:e2e` | `vitest.e2e.config.ts` | a running LM Studio with a loaded model |

`vitest.config.ts` sets `exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**']`, and
`vitest.e2e.config.ts` includes only `tests/e2e/**`. That separation is the contract:
**never** let the real-model tests into `pnpm test`, and do not `include` `tests/e2e` from
the default config. `vitest.e2e.config.ts` is a TypeScript config file — it cannot use a
tsconfig-style `extends`, and it must not import the default config and override
`include`, because the default `exclude` would win.

## Commands

```powershell
pnpm test           # build @ots/contracts, then vitest run (mock suite)
pnpm test:e2e       # real LM Studio end-to-end suite (long; opt-in)
pnpm typecheck      # build @ots/contracts, tsc --noEmit everywhere, then tests/tsconfig.json
pnpm build          # contracts -> web bundle -> server
```

`pnpm typecheck` chains a bare `tsc -p tests/tsconfig.json` because `pnpm -r typecheck`
only covers the workspace packages; the test tree has its own `paths` mapping to the
contracts source (values are relative to `baseUrl`, i.e. the repository root — not to
`tests/`), which is why a repo-wide `paths` entry in `tsconfig.base.json` must not come
back: it breaks the server build's `rootDir`.

The mock suite never starts a real LM Studio, never downloads a model, and needs no
network. Neither suite may write to `apps/server/data/`; every test database lives under
`.temp/tests/` (the harness deletes the `-wal`/`-shm` sidecars with it).

## UI tests (`tests/ui/`)

Client-side behaviour belongs in the default suite: it must not need a model, so it runs
under `pnpm test` alongside everything else. The files are `.tsx`, which is why
`vitest.config.ts` includes both `tests/**/*.test.ts` and `tests/**/*.test.tsx`.

- `translator.test.tsx`, `useTranslator.test.tsx` — output box rendering (position after
  the source textarea, read-only, empty state, disabled actions), the streaming state
  machine, and the source-input 清空 / 直接存历史 buttons.
- `multiselect.test.tsx` — the history multi-select semantics (§9.2): two checkbox ticks
  → 已选 2 条, Ctrl+click toggle, Shift+click range, header select-all, against a stubbed
  JSON API rendering real `history-row` DOM.
- `preferences.test.ts` — preference validation, key versioning, fault tolerance.
- `preferences-hooks.test.tsx` — restore-on-mount, persist-on-change, no first-frame
  overwrite.
- `app-preferences.test.tsx` — `App`-level restore behaviour against a stub JSON API.

One selector gotcha: because the source input and the output box each have a **清空**
button, tests that target the *output* clear button must scope the query to
`.output-actions button` — a bare `button` search now finds the source-input 清空 first
and clicks the wrong one.

Two constraints shape how these are written:

- **A `fetch`-stubbing hook test stays out of jsdom.** jsdom gives `AbortSignal` a copy from
  its own realm, and Node's `fetch` refuses a foreign-realm signal
  (`Expected signal ("AbortSignal {}") to be an instance of AbortSignal`). That looks like
  "the translate request failed" but is purely an artefact of mixing realms, so
  `useTranslator.test.tsx` mocks the SSE client (`vi.mock('.../api/translate')`) in jsdom and
  the real HTTP/SSE path stays covered by `tests/server/translate.test.ts` and
  `tests/unit/adapter.test.ts`. Do not "fix" this by stubbing `AbortController`.
- **App-level tests stub the JSON API, never the model.** `app-preferences.test.tsx`
  installs a `fetch` replacement that answers the collection/status endpoints, avoids the
  streaming route entirely, and matches the list DOM (`.collection-item.active` and
  `.collection-main` are the hooks the collection tests rely on).
- Rendering tests use `createRoot` + `act` with
  `globalThis.IS_REACT_ACT_ENVIRONMENT = true`; without that flag React logs an `act(...)`
  warning on every render. `vitest.config.ts` also sets `resolve.dedupe: ['react',
  'react-dom']`, because React otherwise resolves twice (repository root and `apps/web`) and
  hooks fail with `Cannot read properties of null (reading 'useState')`.

### Sandbox boundary on this machine

Vitest/Vite run esbuild's service as a child process with **piped stdio**, which this
Windows sandbox denies (`spawn EPERM`) in a confined session. That is an environment
boundary, not a project defect: run the suite through the environment's wider-access
flow rather than rewriting the toolchain. The `pnpm install` postinstall scripts hit the
same wall, which is why `pnpm-workspace.yaml` allowlists `esbuild` under `allowBuilds`.

## Mock LM Studio (`tests/mock-lmstudio/server.ts`)

A dependency-free `node:http` server implementing the OpenAI-compatible subset:

- `GET /v1/models` → `{ data: [{ id: 'mock-hy-mt2-30b-a3b', ... }] }`.
- `POST /v1/chat/completions`, non-streaming and streaming.
- The translation is **deterministic**: `X-Mock-Source-Lang: zh` → `EN[<原文>]`,
  `en` → `ZH[<原文>]`. Without the header the direction is inferred from the system
  prompt's `from <lang> to` clause as a fallback. The deterministic mapping is what makes
  end-to-end assertions possible (`expectedTranslation()` exposes it).
- Streaming splits by **character** (`splitEvery`), never by byte, so multi-byte text is
  never cut mid-character. `chunkSize` (default 5) and `chunkDelayMs` are configurable.
- Fault injection via query parameter or the equivalent dashed header:
  `mock_fail=lmstudio_down` (503), `mock_fail=mid_stream_cut` (first chunk, then destroy
  the socket), `mock_fail=hang` (keep-alive comments until the client disappears),
  plus `mock_chunk_size` and `mock_delay_ms`.
- `onRequest` / `onStreamAborted` callbacks let a test wait for a request to arrive
  before acting, instead of guessing with sleeps.

`startMockServer()` binds `127.0.0.1:0`, so tests get a random free port and the mock's
`baseUrl` is passed straight into the harness.

## Harness (`tests/helpers/`)

- `context.ts#createTestContext()` assembles a full backend — database, services, routes,
  shutdown controller — on an ephemeral port. It injects `LMSTUDIO_BASE_URL` rather than
  relying on the `config` singleton (which is evaluated at import time), so several
  contexts can coexist in one process.
- `mockHeaders: true` is the default, and the harness sets the mock-only headers through
  the service options; nothing about production traffic changes.
- `loadedInstances` seeds an in-memory list that stands in for `lms ps --json`, and the
  harness answers `lms unload <id>` by removing from it. That is how unload is asserted:
  by watching the list shrink and the final re-read come back clean.
- `runLms` is injected, so **no test ever executes a real `lms` command** — and with the
  kill path retired there is nothing left to kill either. **No test runs `taskkill` or
  names a process image to clean up.**
- `lmsFailure` ('timeout' / 'spawn-error') and `lmsMissing` drive the degradation paths:
  a stuck or absent CLI must degrade to "do nothing", never to "terminate something".
- `lmsCalls` records the argument vectors, which is how the startup arguments
  (`-p`, `--bind`) and the unload target are asserted.
- `http.ts` provides `api()` (JSON request + typed body), `readSse()` (raw text plus
  parsed events) and `waitFor()` (bounded polling for asynchronous state).

## Scratch cleanup is the test's job, not the runner's

`paths.ts#scratchDir()` only **creates** the directory under `.temp/tests/`; it never
removes anything. A test that allocates a file there must delete it, or `.temp/tests/`
grows by one copy per test per run.

`paths.ts#removeDbFiles(dbPath)` is the shared helper for that — it removes the database
plus its `-wal` / `-shm` sidecars, and swallows failures so cleanup can never turn into a
test failure. It lives in `paths.ts` rather than in `context.ts` because several fixtures
need it, and having it private to one of them is how the leak shipped in the first place.

Two tests were fixed for this and are the reference for the pattern:

- `unit/collectionService.test.ts` — one database per test in `beforeEach`, so it calls
  `removeDbFiles` in `afterEach`.
- `server/lifecycle.test.ts` — the locate test writes a fake `LMStudio.exe`, so it
  removes it in a `finally`.

`context.ts#close()` already did the right thing, which is why `.temp/tests/server/`
stayed empty while `.temp/tests/unit/` accumulated dozens of files.

**Do not "fix" this by wiping `.temp/tests` from the `test` script.** A blanket delete
also throws away the state of a failing run you are debugging, breaks concurrent runs, and
skips cleanup entirely when Vitest crashes (an `&&` chain only runs on success). A
per-test `afterEach` is both narrower and more reliable.

## Pitfall: never bind test listeners with `listen(0)`

Node's `fetch` refuses a list of low ports (6543 among them) with `bad port` before any
connection is attempted, and Windows' ephemeral range can hand `listen(0)` exactly such a
port. The result is an *intermittent* `TypeError: fetch failed / bad port` that looks like
a real defect and can mask one — it cost several debugging rounds here.

Every listener in the test tree therefore goes through
`tests/helpers/paths.ts#listenOnSafePort`, which picks a free port from **49152–65535** and
retries only on `EADDRINUSE`. It backs the harness (`createTestContext`), the mock LM
Studio, both local SSE servers, and the raw `http` servers in individual tests. A
regression assertion in `tests/server/api.test.ts` pins the harness to that range.

If a test needs an *unreachable* endpoint, use a free high port such as `65530` — never a
low port, for the same reason.

## Coverage map (`DESIGN.md` §8.3)

| Case | Test |
|---|---|
| LM Studio already running at startup | `lifecycle.test.ts` (reachable → no spawn), `translate.test.ts` (status) |
| Not running, then started | `lifecycle.test.ts` (spawn, PID/ownership, timeout path) |
| zh→en streaming, delta concatenation, persistence | `translate.test.ts` |
| en→zh streaming | `translate.test.ts` |
| Mid-stream disconnect | `translate.test.ts` (error event, nothing persisted) |
| Collection CRUD and active switching | `api.test.ts`, `unit/collectionService.test.ts` |
| Single and batch delete | `api.test.ts`, `unit/collectionService.test.ts` |
| `POST /api/entries` direct save (no translation) | `api.test.ts` (writes the row; 400 on empty text / bad direction; 404 on missing collection) |
| Deleting the active collection switches automatically | `api.test.ts`, `unit/collectionService.test.ts` |
| Shutdown unloads the model and leaves the server running | `shutdown.test.ts`, `lmstudioRoute.test.ts` |
| Unload targets only `LMSTUDIO_MODEL` and its `:N` instances | `server/lifecycle.test.ts` |
| `lms unload` exit code is ignored; `lms ps --json` decides | `server/lifecycle.test.ts` (residual ⇒ `ok: false`) |
| Unload degrades instead of killing when `lms` fails or hangs | `server/lifecycle.test.ts` |
| Shutdown order: unload → stop accepting → close resources | `shutdown.test.ts` |
| Startup args carry `-p <port>` and `--bind 127.0.0.1` | `server/lifecycle.test.ts` (`serverStartArgs`) |

Extra regression coverage worth keeping:

- `/api/entries/:id` and `/api/collections/:id/entries` ordering and pagination.
- Invalid JSON → `INVALID_JSON`; unknown `/api` path → `NOT_FOUND`.
- SSE frame shape (`event:` + single `data:` + blank line) in `lmstudioRoute.test.ts`.
- Client disconnect cancels the upstream request and persists nothing, driven by an
  actual `http.request().destroy()` so the socket really closes.
- Adapter-level: abort terminates the delta iterator; a cut after the first chunk rejects
  instead of ending cleanly.
- `unit/adapter.test.ts` uses a local cutting server rather than the mock when it needs to
  control exactly how many chunks arrive before the socket dies.

## Real-model E2E (`tests/e2e/`)

Opt-in, deliberately outside the regression gate (§8.3 requires the default suite to work
without LM Studio). Run with `pnpm test:e2e`.

- **Do not skip silently.** `assertRealLmStudioReady()` fails with an actionable Chinese
  message when the endpoint is unreachable, when no model is listed, or when
  `LMSTUDIO_MODEL` names a model the endpoint does not expose. A skipped test would hide
  a broken environment.
- The E2E context (`tests/e2e/helper.ts`) builds a real `LMStudioAdapter` against
  `LMSTUDIO_BASE_URL` (default `http://127.0.0.1:1234`), a scratch database, and a real
  `createApp()`. `autoStart: false` **and** `locate: () => null` mean it can never spawn
  or terminate a real process, and `exit: () => undefined` keeps `/api/shutdown` from
  killing the test runner.
- Model selection mirrors production but avoids extra instances: `LMSTUDIO_MODEL` when
  set, otherwise **the id of an already-loaded instance** from `/api/v0/models`, otherwise
  the first entry of `/v1/models`. Instantiated models also appear as `<id>:2`, `<id>:3`, …
  so any of those ids also works for `chat/completions`.
- **Never let the E2E create a second instance.** `warmup()` must report
  `attempted=false, alreadyResident=true` when the model is resident, and the run log
  prints all of this. If it reports `attempted=true` on a machine that already had the
  model loaded, something regressed in the guard described in
  [lmstudio-lifecycle.md](lmstudio-lifecycle.md).
- Assertions are split by intent. **Strict/structural:** every SSE frame is well formed,
  no `error` frame, the last frame is `done`, `deltas.join('') === done.target_text`,
  `done.model_id` equals the model used, the persisted row matches `done` byte for byte,
  the collection count grows by one, and an over-limit input returns
  `400 INPUT_TOO_LONG` without touching the model. **Loose/quality:** the translation is
  non-empty, contains no `U+FFFD`, differs from the source, and lands on the target
  language by script ratio (`latinRatio > 0.4` / `cjkRatio < 0.2` for zh→en, and the
  reverse for en→zh). Never assert exact wording — a real model rewords freely.
- Timing is asserted only where it is a contract: at least two deltas, and
  `firstDeltaMs < totalMs` (i.e. it really streams instead of buffering everything and
  answering at once). Observed on this machine with the model already resident: zh→en
  ~1.8 s with the first delta at ~0.6 s, en→zh ~1.3 s with the first delta at ~0.5 s.
  A cold model adds a single load (measured `load_time_seconds` ≈ 5 for this 30B MoE
  when the weights are in the OS file cache).
- One test deliberately covers §13-5: `/api/lmstudio/status` must report a loaded model,
  which is what `warmup()` uses to decide whether to call `POST /api/v1/models/load`. A
  second one asserts the *second* warm-up is a no-op (`attempted=false`,
  `alreadyResident=true`) — the regression for the duplicate-instance defect. Verify the
  instance count outside the suite as well: `lms ps` must show exactly one instance after
  the whole run.

## Adding a test

1. Put it under `tests/unit/` if it needs no HTTP, otherwise `tests/server/`.
2. Prefer `createTestContext()` over hand-wiring services.
3. Never assert on real model output; assert on `expectedTranslation()` values.
4. If a test needs the backend to be mid-stream, use the mock's `hang` mode plus
   `onRequest`; do not sleep a fixed duration and hope.
5. Clean up every server you start (`ctx.close()`, `mock.close()`) so ports and child
   processes do not leak into the next file.
