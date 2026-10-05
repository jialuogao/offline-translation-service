# collections-and-db

SQLite access, schema, and the single persistence entry point for collections and
history entries. Governing design: `DESIGN.md` §4, §5.1, §5.2.

## Why not better-sqlite3

`DESIGN.md` §2 originally chose `better-sqlite3`. On this machine it cannot be
installed:

- `prebuild-install` finds no prebuilt binary for Node 26, so it falls back to
  `node-gyp rebuild`;
- `node-gyp` then fails twice over: no Visual Studio C++ toolchain, and (under the
  confined sandbox) piped child-process stdio is denied.

The replacement is Node's built-in `node:sqlite` (`DatabaseSync`, stable synchronously
usable in Node 24+), which is the same synchronous model the design wanted.

`apps/server/src/db/sqlite.ts` is a thin adapter exposing the better-sqlite3-shaped
surface the rest of the code uses — `prepare().run()/get()/all()`, `exec()`, `pragma()`,
`transaction()`, `close()`, `open`:

- `pragma(source)` executes `PRAGMA <source>` and returns the single column value, so
  `db.pragma('journal_mode = WAL')` keeps working.
- `transaction(fn)` wraps `BEGIN`/`COMMIT`/`ROLLBACK` and **supports nesting through
  `SAVEPOINT`** (tracked by a depth counter). SQLite rejects a nested `BEGIN` with
  "cannot start a transaction within a transaction"; that mistake previously turned
  "delete the last collection" into a 500 (the delete transaction called
  `create()`, which opened its own transaction). Nested callers now work, and
  `CollectionService.delete()` was additionally restructured so deleting and creating
  are two separate steps. It still must not wrap async work — the transaction would
  commit early.
- Named parameters in `node:sqlite` use an `@name` prefix rather than better-sqlite3's
  `$name`/`:name`. Everything in this repository uses positional `?`; do not introduce
  named parameters without updating the adapter.

**`node:sqlite` must be loaded through `createRequire`, not a static `import`.**
Node 26's `builtinModules` contains `'node:sqlite'` but not `'sqlite'`, and Vite 5
strips the `node:` prefix before consulting that list. A static import therefore makes
Vite treat it as a file and Vitest fails with `Failed to load url sqlite`. The adapter
still type-imports `DatabaseSync`/`SQLInputValue` for compile-time checking.

## Schema and invariants

`openDb()` sets `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL` and
then applies the schema. `foreign_keys = ON` is a per-connection PRAGMA — without it the
`ON DELETE CASCADE` from `entries` to `collections` silently does nothing.

- Timestamps are ISO 8601 UTC **text**; ordering relies on that being lexicographically
  sortable (`new Date().toISOString()` always has the same length).
- `meta` holds `schema_version` and `active_collection_id`; there is no "current
  collection" table.
- `entries` carries `CHECK (source_lang <> target_lang)` and both-language checks, so an
  invalid direction fails at the database as well as in the service.

## `CollectionService` — the only persistence entry point

No route or other service may touch SQLite. Methods and their design mapping:

| Method | Notes |
|---|---|
| `init()` | Idempotent. Creates the default collection when empty, otherwise keeps `active_collection_id` if it still resolves, else falls back to the most recently updated collection. |
| `list()` | Ordered by `updated_at DESC, created_at DESC` with a correlated `entry_count` subquery. |
| `create(name?, {activate})` | Empty name becomes `未命名合集`; registers as active by default. |
| `setActive(id)` | Updates `updated_at` **only when the active collection actually changes**, so re-selecting the same collection does not reorder the list. |
| `rename(id, name)` | Rejects empty/over-200-character names with `INVALID_REQUEST`. |
| `delete(id)` | Returns the new active collection: the most recently updated survivor, or a newly created default collection when the last one is removed. |
| `listEntries(id, page, pageSize)` | Validates the collection exists (404 otherwise), clamps `pageSize` to `MAX_PAGE_SIZE` (200) and falls back to `DEFAULT_PAGE_SIZE` (50) for junk input. |
| `insertEntry()` | Transactional: inserts the entry and touches the collection in one commit. |
| `deleteEntry` / `batchDeleteEntries` / `clearEntries` | All route through `deleteMany`, which de-duplicates ids, ignores unknown ones, returns the real delete count, and touches each affected collection once. |

### Monotonic `updated_at` (`nextTimestamp()`)

Two writes can land in the same millisecond, and both the list order and the
active-collection fallback depend on `updated_at` ordering. `nextTimestamp()` therefore
returns `max(Date.now(), MAX(updated_at) + 1ms)`. This is what makes "the thing you just
touched sorts first" deterministic, including inside a single-process test run that
creates several collections back to back.

`insertEntry` passes one timestamp to both the entry and the collection touch, so an
entry never claims to be newer than its collection.

## Testing hooks

`tests/helpers/context.ts` builds a real `CollectionService` over a scratch database in
`.temp/tests/server/`; `tests/unit/collectionService.test.ts` exercises the service
directly, including the cascade delete, the empty-collection fallback, pagination
ordering, and two regression tests for the nested-transaction defect ("delete the last
collection" repeated five times, and a batch delete executed inside an outer
transaction). WAL sidecar files (`-wal`, `-shm`) are removed with the database on close.

When a test needs an unreachable endpoint, use a free high port such as `65530`. Node's
`fetch` refuses a list of low ports (6543 among them) with `bad port`, which looks like
a genuine failure but is a client-side restriction — see
[testing-and-mock.md](testing-and-mock.md).
