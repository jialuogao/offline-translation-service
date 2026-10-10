# lmstudio-lifecycle

Locating, spawning, probing and terminating LM Studio, plus the model endpoints that
back `/api/lmstudio/*`. Governing design: `DESIGN.md` §3.3, §3.4, §5.4, §6, §13.

**Read this note before changing anything that can start or kill a process.** The
ownership rules exist to protect the user's machine, not just this application.

## What is actually on this machine (measured 2026)

| Question | Result |
|---|---|
| Does `LM Studio.exe --help` work? | No output at all; the desktop build has **no** `server start` subcommand |
| Is there an official CLI? | Yes: `%USERPROFILE%\.lmstudio\bin\lms.exe` — supports `lms server start`, `lms server status`, `lms ps` |
| Do the registry keys exist? | No: `HKCU\Software\LM Studio`, `HKCU\Software\LMStudio`, `HKLM\Software\LM Studio` are all absent |
| Default install path? | `%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe` exists |
| Does `/v1/models` distinguish loaded models? | No. It lists every model on disk; use `GET /api/v0/models` for `state: "loaded" \| "not-loaded"` |
| Are models preloaded? | No. All models report `not-loaded`; the first inference triggers an implicit load |
| Is `Get-NetTCPConnection` usable? | Not in a normal user session — it fails with "access denied"; `netstat -ano -p tcp` works |

Measured again on 2026-10-05 with the CLI itself:

| Question | Result |
|---|---|
| Is there an `lms` command that launches the **desktop app**? | No explicit one — the CLI exposes only `chat / get / load / unload / ls / ps / import / server / log / link / runtime / clone / push / dev / login / logout / whoami`. But `lms server start` **indirectly** starts a headless `LM Studio.exe --run-as-service` when nothing is running (see below) |
| `lms server start` with the app already open | **290 ms**, exit code 0, leaves **no** `lms.exe` process behind |
| `lms server start` with nothing running (cold) | **3346 ms**, exit code 0, launches `LM Studio.exe --run-as-service` (5 processes, no window), server answers `/v1/models` |
| `lms server stop` | **269 ms**, exit code 0, frees the port, leaves the desktop app untouched (same pid, same start time). **Does not unload the model** |
| Where does `lms` write its messages? | **stderr**, not stdout |
| Can a model be unloaded without touching the server? | Yes — `lms unload <identifier>` (exit 0, ~2.4 s, server keeps listening). A **bare `lms unload` may block on an interactive prompt** when several models are loaded; always pass an identifier or `-a` |
| `lms unload` exit code when the model is **not** loaded? | **Still 0**, printing `Model Not Found`. The exit code is useless for success detection — re-check with `lms ps --json` (returns a clean `[]`) |
| Does `lms server start` accept a port? | `-p, --port <port>` and `--bind <address>` (default `127.0.0.1`). **Without `-p` the server reuses the port from last time**, not necessarily 1234 |
| Is there an idle auto-unload? | `lms ps` shows a `TTL` column counting down (`30m / 1h` → `21m / 1h` over ~9 min), so LM Studio unloads idle models on its own after ~1 h |

## The `lms` CLI can cold-start the server (verified)

An earlier draft of this note claimed the CLI was a thin client that could not start LM
Studio on a cold machine. **That was wrong and has been corrected.** Measured 2026-10-05
with the desktop app fully exited (0 `LM Studio.exe` processes, nothing on port 1234):

```
$ lms server start
Waking up LM Studio service...          <-- written to STDERR
Success! Server is now running on port 1234
exit code 0, 3346 ms
```

Result: 5 `LM Studio.exe` processes appeared, **none with a window**, and the listener was

```
"L:\...\LM Studio.exe" --run-as-service
```

So `lms server start` has two distinct behaviours:

| Precondition | Behaviour | Measured |
|---|---|---|
| Desktop app already running | Asks the running app to open the server | 272–290 ms, no lingering `lms.exe` |
| Nothing running | Launches `LM Studio.exe --run-as-service` (headless, no GUI) | 3346 ms, 5 processes, no window |

Two practical consequences:

- The backend's `spawn('lms.exe', ['server', 'start'])` is genuinely useful on a cold
  machine; the operator does **not** have to open LM Studio first.
- `lms` writes its progress and success messages to **stderr**, not stdout. Piping stdout
  alone (`& $lms ... | Out-Null`) discards them; use file redirection when diagnosing.

**Do not call `lms server status` when nothing is running.** In this session it was the
suspected cause of a command that never returned. Anything invoked from the service should
run as a bounded child process with its own timeout, never as an unbounded foreground call.

## LM Studio is an Electron app; the main process is not the one that looks like the app

With the desktop app open there are **six** processes all named `LM Studio.exe`:

| Role marker | Role |
|---|---|
| *(no arguments)* | **main process** — also the one holding the port-1234 socket |
| `--type=gpu-process` | GPU child (the one with the earliest-looking PID is *not* this) |
| `--type=utility --utility-sub-type=network.mojom.NetworkService` | network |
| `--type=utility --utility-sub-type=node.mojom.NodeService` | node |
| `--type=renderer` | renderer |
| `--type=crashpad-handler` | crash reporting |

`MainWindowHandle` is `0` on the main process, so `taskkill /PID <main>` reports success via
WM_CLOSE while the app stays alive. Signalling a **child** PID (e.g. the GPU process) is a
silent no-op. Only the main process exits the whole tree. `findPidListeningOnPort` picking the
lowest PID happens to land on the main process here, which is lucky rather than guaranteed.

## Resident model state lives in the app process

Verified separately: with the server **stopped** (`lms server status` → "not running", port
1234 free, `/v1/models` refusing), `lms ps` still reports
`hy-mt2-30b-a3b-uncensored-v1-apex  IDLE  14.23 GB  Local`. Stopping the server does **not**
unload the model, and only the app process holds that state.

## Consequence: the recorded child PID is dead on arrival (historical)

> This section explains the **pre-§6.4** design, when the manager recorded a PID to
> decide shutdown ownership. §6.4 deleted `startedByUs` / `pid` and all PID-based
> termination, so the "recording" it critiques no longer exists; the hazard analysis
> (Windows PID reuse) is what remains worth remembering.

`launch()` spawns `lms.exe server start` and records **that CLI's PID**. Since the CLI exits
after ~290 ms, the PID is stale almost immediately:

- `child.on('exit')` fires and resets `child = null` / `startedByUs = false` (see
  `process.ts`), while `startup()` returns a **hard-coded** `startedByUs: true`.
  `startup()`'s return value and `status()` therefore disagree.
- Since `run.ps1` starts LM Studio before the backend boots, the backend's early
  "already running" return path is what actually runs in practice, so the UI always sees
  `startedByUs === false`.
- The stale PID must **never** be passed to `taskkill`: Windows reuses PIDs, so it could
  hit an unrelated process. `DESIGN.md` §6.4 now forbids every PID-based termination, which
  retires this hazard by construction.

The unit tests miss this because `tests/server/lifecycle.test.ts` substitutes
`nodeChild()` — a **long-lived** `node -e` process — for `lms.exe`. A process that never
exits never fires the `exit` listener, so the hole is invisible to the suite.

## Shutdown is unload-only (implemented)

`DESIGN.md` §6.4 was re-decided on 2026-10-05 and **implemented in the same change**:
the service **never terminates LM Studio** and **never runs `lms server stop`**. It
unloads only the model named by `LMSTUDIO_MODEL` (including every `:N` instance of
it), verifies with `lms ps --json`, and leaves the server running.

`LMStudioProcessManager.shutdown({ force })`, the `startedByUs` / `pid` fields and
the `findPid` / `isLmStudio` / `terminate` injection points are **gone**. What
replaced them is `unload()` plus the `lmsCli.ts` runner. The historical behaviour
this retired is not described anywhere in the code any more.

Everything below that still speaks of `shutdown({ force })`, `startedByUs` or
`stoppedByUs` is stale — those sections were kept only to record why the old design
was abandoned, and should be read as history, not as current behaviour.

## `lmsCli.ts` — every `lms` call is a bounded child process

`runLms(exePath, args, timeoutMs)` wraps `execFile` with `windowsHide`, a hard timeout
and both streams captured. Two design points that are easy to get wrong:

- **Never call `lms` in the foreground.** `lms server status` was observed not
  returning when nothing was running, which hung a diagnostic session outright.
- **`lms unload` always exits 0**, even printing `Model Not Found` for a model that is
  not resident. Success therefore cannot come from the exit code; `unload()` re-reads
  `lms ps --json` and reports `ok` only when the target id and its `:N` variants are
  gone. `residual` is populated when the re-read still finds them, which is the signal
  that memory was **not** freed.

`parseLoadedIdentifiers` treats anything that is not a JSON array of `{identifier}`
as "cannot confirm" rather than "nothing loaded", and `unload()` only accepts a
literal `[]` as proof that the list is empty. Conflating the two would silently skip
the unload. `instancesOf()` matches `id` and `id:N` but not `id2`, so a model whose
name merely starts with the target is left alone.

## Resolution order (`locate.ts`)

`locateLmStudio()` tries, in order:

1. `LMSTUDIO_EXE` — must be an existing file, otherwise resolution returns `null`
   (an explicit override that is wrong should fail loudly, not silently fall through).
2. `lms` / `lmstudio` on `PATH`, searched by splitting `PATH` directly (no `where`
   subprocess).
3. `lms.exe` under `%USERPROFILE%\.lmstudio\bin`, `%USERPROFILE%\.cache\lm-studio\bin`,
   `%LOCALAPPDATA%\LM-Studio`, `%LOCALAPPDATA%\Programs\lm-studio`.
4. Desktop `LM Studio.exe` under `%LOCALAPPDATA%\Programs`, `%PROGRAMFILES%`,
   `%PROGRAMFILES(X86)%`.
5. Registry `InstallLocation`/`InstallPath` values, last because the keys do not exist
   here and each lookup spawns `reg`.

`build()` picks the arguments: `lms-cli` → `['server', 'start']` (overridable with
`LMSTUDIO_START_ARGS`), `desktop` → no arguments. Resolution failure is not fatal: the
service still starts and translation degrades to `LMSTUDIO_UNAVAILABLE`.

**Only `kind === 'lms-cli'` is ever spawned.** The desktop build has no `server start`
and no `unload`, so resolving to it means the service cannot manage anything; it logs
that and continues with `running: false` instead of launching a GUI application
(`DESIGN.md` §6.3).

`serverStartArgs(baseUrl, locatedArgs)` appends `-p <port>` and `--bind 127.0.0.1`
before the spawn. It is a pure exported function so the arguments can be asserted
without mocking ESM `spawn`, which cannot be redefined.

## `LMStudioProcessManager`

State is just `child` (the spawned process, if any). The injectable collaborators are
`locate`, `runLms` and `sleep`, which is how the tests exercise every branch without
running a real `lms` command or touching a real LM Studio. The former `findPid` /
`isLmStudio` / `terminate` injection points are gone with the kill path.

### `startup()`

1. Probe once — reachable means `{ running: true }`, **no spawn**.
2. Respect `LMSTUDIO_AUTOSTART`; when disabled, never even locate the executable.
3. Locate; if resolution yields the **desktop** build, stop here with `running: false`
   (it has no `lms` subcommands, so nothing could be started or unloaded later).
4. Otherwise `spawn(serverStartArgs(...), { windowsHide: !LMSTUDIO_SHOW_CONSOLE, detached: false, stdio: 'ignore' })`,
   attach `error`/`exit` listeners, and `unref()` the child so it never keeps this
   process alive. **No PID is recorded** — see "dead on arrival" above.
5. Poll `waitUntilReachable()` — interval is `LMSTUDIO_PROBE_INTERVAL_MS` for the first
   10 attempts, then doubles to a 3000 ms ceiling, bounded by
   `LMSTUDIO_STARTUP_TIMEOUT_MS`.
6. Return `running: false` on timeout. There is nothing to clean up afterwards by
   design: the server is hosted by LM Studio, not by the process we spawned.

### Historical: `shutdown({ force })` (removed)

This is what §6.4 replaced. Kept only to record why it was abandoned:

- `startedByUs === true` → `taskkill /PID <pid> /T /F` via the recorded child PID.
- `startedByUs === false` and no `force` → 409 `LMSTUDIO_NOT_OWNED`, UI confirmation.
- `startedByUs === false` and `force === true` → resolve the PID from the port, verify
  the process name, then kill.

It failed for two independent reasons: the recorded PID belonged to a short-lived CLI
and could be recycled by Windows, and stopping the *server* never freed the model
anyway (the weights live in the desktop app process). `unload()` fixes both.

### Process identity checks (`winProcess.ts`)

- `findPidListeningOnPort` parses `netstat -ano -p tcp` for `LISTENING` rows whose local
  address ends in `:<port>`, taking the **lowest** PID when several exist, and falls back
  to PowerShell `Get-NetTCPConnection` only if `netstat` yields nothing.
- `isLmStudioProcess` runs `tasklist /FI "PID eq <pid>" /FO CSV /NH` and requires the
  image name or session name to match `LM Studio`. Any doubt returns `false`. This check
  is what keeps a foreign process squatting on port 1234 from being killed.

**Neither function is called by production code any more** — §6.4 removed every
PID-based termination. They stay because the probing methods are verified and reusable
if process management is ever deliberately reinstated. `terminateProcessTree` is the
only one that actually acts, and nothing calls it. See `AGENTS.md`
("LM Studio process safety"): ask the user before removing any of it.

### Warm-up and the "ensure model ready" loop (`warmup()` / `ensureModelReady()`)

`GET /api/v0/models` reports models that are on disk as `not-loaded`, so the first
translation would pay an implicit load. After the endpoint is reachable, `bootstrap.ts`
fires the **ensure-model-ready loop** without awaiting it (so HTTP startup is not
blocked):

- `ensureModelReady()` (DESIGN.md §6.3) replaces the old single-shot warm-up. Each of
  `LMSTUDIO_RETRY_ATTEMPTS` (default 3) rounds:
  1. ensures the server is reachable (`lms server start` is idempotent — it returns
     `Success! Server is now running` even when already running, ~250 ms; cold start
     ~3.3 s);
  2. reads the **official** loading state from `GET /api/v0/models` (`state: loading →
     loaded`, also `not-loaded`) and only acts when needed:
     - `loaded` → done, **never calls load again** (see "Why the load call must be
       guarded" below);
     - `loading` → waits up to `LMSTUDIO_LOAD_WAIT_TIMEOUT_MS` and re-checks — loading is
       **not** a failure (measured 30B cold load: `loading` from ~1.2 s to `loaded` at
       ~8.3 s);
     - `not-loaded` → calls `POST /api/v1/models/load` once, then re-checks.
  3. on failure records the reason, waits `LMSTUDIO_RETRY_INTERVAL_MS` (default 10 s),
     and retries.
- `lms ps --json` is **not** usable as the loading check: its `status` field reads
  `idle` while a model is still loading.
- `warmup()` itself is retained as the single-shot primitive (tests and E2E call it
  directly); `ensureModelReady()` drives the loop and tracks progress in
  `getModelLoadState()`, which `GET /api/service/status` (DESIGN.md §5.4) reports to
  callers like `run.ps1`.

When all rounds are exhausted the service **keeps running** (best-effort): translation
falls back to `LMSTUDIO_UNAVAILABLE` while collections/history still work, and the
failure is reported faithfully by `/api/service/status` (`lmstudio: error`). Set
`LMSTUDIO_WARMUP=false` to skip the loop entirely.

`bootstrap.ts` passes `config.lmstudioModel`, which since 2026-10-05 defaults to a
**specific** model id rather than empty. It used to be empty, which made `resolveModel()`
fall through to "first entry of `/v1/models`" — a choice dictated by LM Studio's list
order rather than by us. Load, warm-up and unload now all agree on the same id.

#### Why the load call must be guarded (verified defect)

`POST /api/v1/models/load` **creates a new instance every time it succeeds**, even when
that model is already resident. Each instance is a full copy of the weights, and
LM Studio lists them as `model`, `model:2`, `model:3`, … Repeated warm-ups therefore
consume the machine: on this host five 30B instances (~14.23 GB each) drove LM Studio to
reject further loads with

```json
{"error":{"type":"model_load_failed","message":"... insufficient system resources ..."}}
```

Inference is **not** the problem: `POST /v1/chat/completions` reuses an existing instance
and never creates one (verified by counting `lms ps` instances around a request). Only
the explicit load endpoint multiplies instances.

Guards, all of them necessary:

- `LMStudioAdapter.loadModel()` returns `true` immediately when the model is already
  resident, and never issues the request.
- `LMStudioProcessManager.warmup()` returns
  `{ attempted: false, alreadyResident: true }` in that case, so the log line says the
  model was already in memory instead of claiming a fresh preload.
- Residency is decided by `isModelResident(models, id)`, which scans **all** entries whose
  id is the target or `<target>:<n>`. Checking only the first match misses the case where
  the bare id reads `not-loaded` while `model:2` is loaded.
- A `state` of `unknown` (an endpoint that only serves `/v1/models`) does not count as
  resident — better one load than a wrong skip.

Regression tests: `tests/server/lifecycle.test.ts` §13-5 (already-resident skip, `:N`
instance skip, exactly one load for a cold model, second warm-up is a no-op).

If instances do pile up, eject the extras in the LM Studio UI or with
`lms unload <instance-id>`; do not expect a later load to clean them up.

## Status reporting

`probeStatus()` is what `GET /api/lmstudio/status` returns:

- `running` comes from a live probe, not from our bookkeeping.
- `modelLoaded` prefers a model whose `state` is `loaded`, else the first listed model.
- `startedByUs` and `pid` were **removed** on 2026-10-05. They existed to drive the
  ownership decision that §6.4 deleted, the ownership value was wrong in practice (the
  short-lived CLI's `exit` listener reset it within ~300 ms), and the PID was a stale
  number with no diagnostic value.

`GET /api/lmstudio/models` returns `{ models: [] }` when the endpoint is unreachable
rather than propagating an error; `running` in `/status` is what expresses that state.

## Safety rules for tests and future changes

- Tests must never run a real `lms` command. `tests/helpers/context.ts` answers every
  `lms` call from an in-memory instance list, so `lms unload` is asserted by watching
  that list shrink and `lms ps --json` by what it reports.
- There is no `taskkill`, no `process.kill` and no image-name cleanup anywhere in
  `tests/`. When §6.4 retired the kill path, the test harness stopped spawning a
  stand-in process entirely — there is nothing left to kill.
- Never terminate by image name, and never run a blanket process cleanup. The service as
  it stands cannot terminate LM Studio at all; if you reintroduce that, read
  `AGENTS.md` ("LM Studio process safety") and restore the whole chain.
- `shutdown.ps1` in the repo root is a **thin HTTP wrapper** for programmatic shutdown,
  not a cleanup script: it posts `/api/shutdown` and then polls `/api/collections` until
  the connection is refused. It must never kill a process. The poll is not optional —
  the shutdown response only means "accepted", while the actual unload still runs, and
  killing the terminal window during that window would cancel the unload.
