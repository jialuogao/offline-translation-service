import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * SQLite 访问层（DESIGN.md §4）。
 *
 * 设计稿指定 `better-sqlite3`；本机实测无法安装：Node 26 没有对应预编译产物，
 * `prebuild-install` 回退到 node-gyp，而本机没有 Visual Studio C++ 工具链。
 * Node 24+ 内置的 `node:sqlite` 提供等价的**同步** API（`DatabaseSync`），因此
 * 这里放一个薄适配层，让业务代码继续用 `prepare().get()/all()/run()` 这套写法，
 * 不引入编译期原生依赖。适配层只做接口归一，不含业务逻辑。
 *
 * `node:sqlite` 通过 `createRequire` 解析而不是静态 `import`：Vite 5 的内置模块
 * 判定表早于该模块（`builtinModules` 里只有带前缀的 `node:sqlite`），静态 import
 * 会被 Vite 当成普通文件解析并在 Vitest 下报 `Failed to load url sqlite`。
 * 命名参数使用 `@name` 前缀（与 better-sqlite3 的 `$name`/`:name` 不同），
 * 但本项目全部使用位置参数 `?`，无需转换。
 */

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncImpl } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (filename: string) => DatabaseSync;
};

/** 与 better-sqlite3 兼容的最小连接接口。 */
export interface Database {
  prepare<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): Statement<Params, Row>;
  exec(sql: string): void;
  pragma(source: string): unknown;
  close(): void;
  readonly open: boolean;
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result;
}

export interface Statement<Params extends unknown[] = unknown[], Row = unknown> {
  run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

class StatementAdapter<Params extends unknown[], Row> implements Statement<Params, Row> {
  constructor(private readonly statement: StatementSync) {}

  run(...params: Params): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.statement.run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get(...params: Params): Row | undefined {
    const row = this.statement.get(...(params as SQLInputValue[]));
    return row === undefined ? undefined : (row as Row);
  }

  all(...params: Params): Row[] {
    return this.statement.all(...(params as SQLInputValue[])) as Row[];
  }
}

class DatabaseAdapter implements Database {
  private readonly db: DatabaseSync;
  private closed = false;
  /** SAVEPOINT 嵌套深度：内部 `transaction()` 不能再次 `BEGIN`。 */
  private depth = 0;

  constructor(filename: string) {
    this.db = new DatabaseSyncImpl(filename);
  }

  prepare<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): Statement<Params, Row> {
    return new StatementAdapter<Params, Row>(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(source: string): unknown {
    // `journal_mode` 之类的 PRAGMA 会返回一行；与 better-sqlite3 一样返回该值。
    const rows = this.db.prepare(`PRAGMA ${source}`).all() as Array<Record<string, unknown>>;
    const first = rows[0];
    if (first === undefined) return undefined;
    const values = Object.values(first);
    return values.length === 1 ? values[0] : first;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  get open(): boolean {
    return !this.closed;
  }

  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result {
    return (...args: Args): Result => {
      // 嵌套调用用 SAVEPOINT，而不是再次 BEGIN（SQLite 会报
      // "cannot start a transaction within a transaction"）。
      const name = `ots_sp_${this.depth}`;
      this.depth += 1;
      this.db.exec(this.depth === 1 ? 'BEGIN' : `SAVEPOINT ${name}`);
      try {
        const result = fn(...args);
        this.db.exec(this.depth === 1 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(this.depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
          if (this.depth > 1) this.db.exec(`RELEASE ${name}`);
        } catch {
          /* 回滚失败时保留原始错误 */
        }
        throw error;
      } finally {
        this.depth -= 1;
      }
    };
  }
}

/** 打开（必要时创建）数据库文件。目录需由调用方保证存在。 */
export function openDatabase(filename: string): Database {
  return new DatabaseAdapter(filename);
}
