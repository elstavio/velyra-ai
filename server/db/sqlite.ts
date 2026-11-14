import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
import type { Db, Row } from './index.js';

// Outil de vérification : SQL_TRACE_FILE enregistre chaque requête (rejouable sur PostgreSQL pour valider la portabilité).
const TRACE = process.env.SQL_TRACE_FILE;
const trace = (o: unknown) => { if (TRACE) appendFileSync(TRACE, JSON.stringify(o) + '\n'); };

const toQmark = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
const clean = (p: unknown[] = []) =>
  p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as any)));

export function openSqlite(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  // node:sqlite est synchrone : on sérialise requêtes et transactions pour qu'aucune requête
  // d'une autre demande ne s'intercale dans une transaction ouverte.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const exec = {
    all: (sql: string, p?: unknown[]) => { trace({ sql, p: clean(p) }); return raw.prepare(toQmark(sql)).all(...clean(p)) as Row[]; },
    run: (sql: string, p?: unknown[]) => { trace({ sql, p: clean(p) }); return Number(raw.prepare(toQmark(sql)).run(...clean(p)).changes); },
  };

  const make = (locked: boolean): Db => ({
    dialect: 'sqlite',
    query: async (sql, p) => (locked ? (exec.all(sql, p) as any) : exclusive(() => exec.all(sql, p) as any)),
    get: async (sql, p) => (locked ? (exec.all(sql, p)[0] as any) : exclusive(() => exec.all(sql, p)[0] as any)),
    run: async (sql, p) => ({ changes: locked ? exec.run(sql, p) : await exclusive(() => exec.run(sql, p)) }),
    tx: async (fn) => {
      if (locked) return fn(inner); // transaction imbriquée : on réutilise la transaction courante
      return exclusive(async () => {
        trace({ ctl: 'BEGIN' });
        raw.exec('BEGIN IMMEDIATE');
        try {
          const r = await fn(inner);
          trace({ ctl: 'COMMIT' });
          raw.exec('COMMIT');
          return r;
        } catch (e) {
          trace({ ctl: 'ROLLBACK' });
          raw.exec('ROLLBACK');
          throw e;
        }
      });
    },
    close: async () => raw.close(),
  });
  const inner = make(true);
  return make(false);
}
