import type { Db, Row } from './index.js';

// Types minimaux du paquet `pg` (installé via npm sur le serveur de déploiement).
interface PgClient { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>; release(): void }
interface PgPool { query: PgClient['query']; connect(): Promise<PgClient>; end(): Promise<void> }

const clean = (p: unknown[] = []) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export async function openPostgres(url: string): Promise<Db> {
  const moduleName = 'pg';
  const mod: any = await import(moduleName);
  const pg = mod.default ?? mod;
  // COUNT/SUM renvoient des bigint/numeric (texte) : tous nos montants sont des entiers -> Number.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  // rejectUnauthorized: false — Render confirme que ses connexions internes utilisent un certificat
  // auto-signé et ne prennent pas en charge la vérification verify-ca/verify-full (voir
  // https://render.com/docs/postgresql-creating-connecting#ssl-modes-for-internal-connections).
  // La connexion reste chiffrée en TLS ; seule la chaîne de certificats n'est pas vérifiée.
  const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false };
  const pool: PgPool = new pg.Pool({ connectionString: url, max: 10, ssl });

  const make = (q: PgClient['query'], inTx: boolean): Db => ({
    dialect: 'postgres',
    query: async (sql, p) => (await q(sql, clean(p))).rows as any,
    get: async (sql, p) => (await q(sql, clean(p))).rows[0] as any,
    run: async (sql, p) => ({ changes: (await q(sql, clean(p))).rowCount ?? 0 }),
    tx: async (fn) => {
      if (inTx) return fn(make(q, true));
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(make(c.query.bind(c), true));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  });
  return make(pool.query.bind(pool), false);
}
