import type { Db } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { HttpError, bad, nowIso, str, uid } from '../lib/util.js';
import { USER_COLS, type UserRow } from './auth.js';

const MAX_KEYS = 5;
export async function createApiKey(db: Db, userId: string, name: unknown) {
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL`, [userId]))?.n ?? 0;
  if (n >= MAX_KEYS) throw bad('keys_full', `Maximum ${MAX_KEYS} clés actives`);
  const key = `vly_${randomToken(32)}`;
  const id = uid();
  await db.run(`INSERT INTO api_keys (id,user_id,name,prefix,key_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, userId, str(name, 'nom', { min: 2, max: 60 }), key.slice(0, 8), sha256(key), nowIso()]);
  return { id, key }; // la clé complète n'est montrée qu'une seule fois ; seul son hachage est conservé
}
export async function listApiKeys(db: Db, userId: string) {
  return db.query<any>(`SELECT id,name,prefix,last_used_at,revoked_at,created_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
}
export async function revokeApiKey(db: Db, userId: string, id: string) {
  const r = await db.run(`UPDATE api_keys SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [id, userId, nowIso()]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Clé introuvable');
}
export async function authenticateApiKey(db: Db, key: string | null): Promise<{ user: UserRow; keyId: string } | null> {
  if (!key || !key.startsWith('vly_')) return null;
  const k = await db.get<{ id: string; user_id: string; revoked_at: string | null; last_used_at: string | null }>(`SELECT id,user_id,revoked_at,last_used_at FROM api_keys WHERE key_hash=$1`, [sha256(key)]);
  if (!k || k.revoked_at) return null;
  const user = await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [k.user_id]);
  if (!user || user.status !== 'active') return null;
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) await db.run(`UPDATE api_keys SET last_used_at=$2 WHERE id=$1`, [k.id, nowIso()]);
  return { user, keyId: k.id };
}
