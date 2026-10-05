# Implementation Notes

English notes describing **verified** mechanisms in this repository. `DESIGN.md` is
the product and architecture authority (Chinese); when these notes and the code
disagree, the code is right and the note is stale — fix it here.

| Note | Owning subsystem | Source |
|---|---|---|
| [runtime-and-config.md](runtime-and-config.md) | Startup order, configuration, shutdown wiring | `apps/server/src/index.ts`, `bootstrap.ts`, `config.ts`, `shutdown.ts` |
| [collections-and-db.md](collections-and-db.md) | SQLite schema, migrations, collection/entry persistence | `apps/server/src/db/`, `services/collectionService.ts` |
| [lmstudio-lifecycle.md](lmstudio-lifecycle.md) | Locating, spawning, probing and terminating LM Studio | `apps/server/src/lmstudio/` |
| [translation-and-sse.md](translation-and-sse.md) | Prompt construction, streaming, REST/SSE contracts | `services/translationService.ts`, `routes/`, `http/` |
| [web-client.md](web-client.md) | React SPA structure and interaction semantics | `apps/web/src/` |
| [testing-and-mock.md](testing-and-mock.md) | Mock LM Studio and the regression suite | `tests/` |

## Source-to-note map

| Source path | Note |
|---|---|
| `apps/server/src/index.ts`, `bootstrap.ts`, `config.ts`, `shutdown.ts` | `runtime-and-config` |
| `apps/server/src/db/*`, `services/collectionService.ts` | `collections-and-db` |
| `apps/server/src/lmstudio/*` | `lmstudio-lifecycle` |
| `apps/server/src/services/translationService.ts` | `translation-and-sse` |
| `apps/server/src/routes/*`, `apps/server/src/http/*` | `translation-and-sse` |
| `apps/web/src/*` | `web-client` |
| `tests/ui/*` | `web-client` (hook/render behaviour) and `testing-and-mock` (how to run and structure the DOM tests) |
| `tests/*` (rest) | `testing-and-mock` |
| `packages/contracts/src/index.ts` | `translation-and-sse` / `web-client` |

## Reading guide

- Changing how the process starts or shuts down (§3.3, §3.4) → `runtime-and-config`.
- Touching SQL, timestamps or ordering → `collections-and-db`.
- Anything that can start or kill a process → `lmstudio-lifecycle` first, for the
  ownership rules; a mistake there affects the user's machine, not just this app.
- Prompt text, SSE framing or error codes → `translation-and-sse`.
- Multi-select, streaming display or lifecycle dialogs → `web-client`.
- Adding a regression test or changing the harness → `testing-and-mock`.

Operator-facing setup, running and troubleshooting live in
[`docs/usage.md`](../usage.md), not here.
