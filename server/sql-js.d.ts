declare module 'sql.js' {
  /** SQLite column value — the types SQLite can store. */
  type SqlValue = number | string | Uint8Array | null;

  interface SqlJsStatement {
    bind(params?: SqlValue[]): boolean;
    step(): boolean;
    get(): SqlValue[];
    getAsObject(): Record<string, SqlValue>;
    getColumnNames(): string[];
    getSQL(): string;
    getNormalizedSQL(): string;
    getBlob(col: number): Uint8Array;
    run(params?: SqlValue[]): void;
    reset(): void;
    freemem(): void;
    free(): void;
  }

  interface SqlJsDatabase {
    run(sql: string, params?: SqlValue[]): SqlJsDatabase;
    exec(sql: string): Array<{ columns: string[]; values: SqlValue[][] }>;
    each(
      sql: string,
      params: SqlValue[],
      callback: (row: Record<string, SqlValue>) => void,
      done?: () => void,
    ): SqlJsDatabase;
    prepare(sql: string): SqlJsStatement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
    create_function(name: string, fn: (...args: SqlValue[]) => SqlValue): void;
    create_aggregate(
      name: string,
      init: () => unknown,
      step: (state: unknown, ...args: SqlValue[]) => unknown,
      finalize: (state: unknown) => SqlValue,
    ): void;
    handleError(returnCode: number): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
  }

  export type { SqlJsStatement, SqlJsDatabase, SqlJsStatic, SqlValue };
  export default function initSqlJs(): Promise<SqlJsStatic>;
}
