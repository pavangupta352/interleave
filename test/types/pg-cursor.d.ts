declare module 'pg-cursor' {
  import type { Connection, Submittable } from 'pg';
  class Cursor<Row = Record<string, unknown>> implements Submittable {
    constructor(text: string, values?: unknown[], config?: { rowMode?: 'array' });
    submit(connection: Connection): void;
    read(rows: number): Promise<Row[]>;
    close(): Promise<void>;
  }
  export = Cursor;
}
