import { config } from '../config.js';

export type Row = Record<string, any>;

export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  /** Les requêtes utilisent des paramètres positionnels $1, $2… (portables SQLite/PostgreSQL). */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(): Promise<Db> {
  if (config.databaseUrl) {
    const { openPostgres } = await import('./postgres.js');
    return openPostgres(config.databaseUrl);
  }
  const { openSqlite } = await import('./sqlite.js');
  return openSqlite(config.sqlitePath);
}
