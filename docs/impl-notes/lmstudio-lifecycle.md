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

`DESIGN.md` §6.2/§6.3 and §13 record these conclusions.

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

## `LMStudioProcessManager`

State is `child` (the spawned process, if any), `startedByUs`, `stoppedByUs`. All the
process-touching collaborators (`locate`, `findPid`, `isLmStudio`, `terminate`, `sleep`)
are injectable, which is how the tests exercise every branch without touching a real
LM Studio.

### `startup()`

1. Probe once — reachable means `{ running: true, startedByUs: false }`, **no spawn**.
2. Respect `LMSTUDIO_AUTOSTART`; when disabled, never even locate the executable.
3. Locate, `spawn(..., { windowsHide: !LMSTUDIO_SHOW_CONSOLE, detached: false, stdio: 'ignore' })`,
   set `startedByUs = true`, attach `error`/`exit` listeners, `unref()` the child so it
   never keeps this process alive.
4. Poll `waitUntilReachable()` — interval is `LMSTUDIO_PROBE_INTERVAL_MS` for the first
   10 attempts, then doubles to a 3000 ms ceiling, bounded by
   `LMSTUDIO_STARTUP_TIMEOUT_MS`.
5. Return `running: false` on timeout while **keeping** `startedByUs = true`: the child
   exists and we own it, so it must still be cleaned up on shutdown.

The `exit` listener marks the process as gone (so `running` becomes false and a later
`startup()` can retry), unless we are the ones shutting it down.

### `shutdown({ force })`

- `startedByUs === true` → `taskkill /PID <pid> /T /F` via the recorded child PID. This
  path ignores `force`, per §5.4.
- `startedByUs === false` and `force !== true` → `{ ok: false }`, which the route turns
  into **409 `LMSTUDIO_NOT_OWNED`**. The user must confirm in the UI first.
- `startedByUs === false` and `force === true` → resolve the PID from
  `LMSTUDIO_BASE_URL`'s port, verify the process name really is LM Studio, then kill.
  No listener on the port means the target is already gone (`ok: true`).
- `ok` means "terminated **and** the endpoint is no longer reachable"; success is not
  required, failures are logged and ignored (§6.4).

### Process identity checks (`winProcess.ts`)

- `findPidListeningOnPort` parses `netstat -ano -p tcp` for `LISTENING` rows whose local
  address ends in `:<port>`, taking the **lowest** PID when several exist, and falls back
  to PowerShell `Get-NetTCPConnection` only if `netstat` yields nothing.
- `isLmStudioProcess` runs `tasklist /FI "PID eq <pid>" /FO CSV /NH` and requires the
  image name or session name to match `LM Studio`. Any doubt returns `false`. This check
  is what keeps a foreign process squatting on port 1234 from being killed.

### Warm-up (`warmup()`)

`GET /api/v0/models` reports models that are on disk as `not-loaded`, so the first
translation would pay an implicit load. After the endpoint is reachable, `bootstrap.ts`
fires `warmup()` **without awaiting it**; it picks the first already-loaded model (else
the first listed model) and calls `POST /api/v1/models/load` with the generous
`LMSTUDIO_LOAD_TIMEOUT_MS`. Failure is logged and ignored. Set `LMSTUDIO_WARMUP=false`
to skip.

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
- `startedByUs` comes **only** from our own record. It stays `true` for a process we
  spawned even while it is still loading and therefore not yet reachable — the UI must
  still be told to close what this session owns.
- `modelLoaded` prefers a model whose `state` is `loaded`, else the first listed model.
- `pid` is the recorded child PID, present only when we spawned it.

`GET /api/lmstudio/models` returns `{ models: [] }` when the endpoint is unreachable
rather than propagating an error; `running` in `/status` is what expresses that state.

## Safety rules for tests and future changes

- Tests must never start or stop a real LM Studio. Spawn-based tests substitute
  `process.execPath` running `setInterval(() => {}, 1000)`, and every termination goes
  through an injected `terminate` stub. There is no `taskkill` or image-name cleanup
  anywhere in `tests/`.
- Never terminate by image name, never run a blanket process cleanup, and never remove
  the process-name verification before the `force` path.
- When `startedByUs === false`, the signal path (§3.4-B) must never touch LM Studio, no
  matter how tempting it is to "clean up".
