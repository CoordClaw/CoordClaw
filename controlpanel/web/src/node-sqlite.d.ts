// Type declarations for experimental node:sqlite (Node.js 22+)
// Matches the subset used by database.ts
declare module 'node:sqlite' {
  interface DatabaseSyncOptions {
    readonly?: boolean;
  }

  interface StatementSyncResult {
    [key: string]: any;
  }

  class StatementSync {
    all(...params: any[]): StatementSyncResult[];
    get(...params: any[]): StatementSyncResult | undefined;
    run(...params: any[]): void;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
