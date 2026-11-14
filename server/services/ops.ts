import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '../db/index.js';
import { BACKUP_TABLES } from '../db/schema.js';
import { config } from '../config.js';
import { decryptBuffer, encryptBuffer } from '../lib/crypto.js';
import { nowIso, uid } from '../lib/util.js';
import { logEvent, purgeExpiredBlocks } from './security.js';
import { notifyOwner } from './notify.js';

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

// ----------------------------------------------------------------------------- surveillance (§7)
export async function healthCheck(db: Db): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const t = Date.now();
  try {
    await db.get(`SELECT 1 AS ok`);
    const r = { ok: true, latencyMs: Date.now() - t };
    await db.run(`INSERT INTO health_checks (id,ok,detail,latency_ms,created_at) VALUES ($1,1,NULL,$2,$3)`, [uid(), r.latencyMs, nowIso()]);
    return r;
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t, detail: String(e?.message ?? e) };
  }
}

export async function recordError(db: Db, e: unknown, route?: string) {
  try {
    const err = e as Error;
    await db.run(`INSERT INTO error_log (id,message,stack,route,created_at) VALUES ($1,$2,$3,$4,$5)`, [uid(), String(err?.message ?? e).slice(0, 500), String(err?.stack ?? '').slice(0, 2000), route ?? null, nowIso()]);
  } catch { /* ne jamais masquer l'erreur d'origine */ }
}

/** Détecte une dégradation (taux d'erreurs, échecs de contrôle de santé) et alerte le propriétaire, au plus une fois par heure. */
export async function selfMonitor(db: Db): Promise<{ errorsLast15m: number; alerted: boolean }> {
  const errs = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM error_log WHERE created_at >= $1`, [new Date(Date.now() - 15 * 60_000).toISOString()]))?.n ?? 0;
  let alerted = false;
  if (errs >= 20) {
    const last = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key='last_error_alert'`);
    if (!last || Date.parse(last.value) < Date.now() - 3_600_000) {
      await db.run(`INSERT INTO settings (key,value) VALUES ('last_error_alert',$1) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [nowIso()]);
      await logEvent(db, 'error_rate_high', 'high', { detail: { errorsLast15m: errs } });
      alerted = true;
    }
  }
  return { errorsLast15m: errs, alerted };
}

// ----------------------------------------------------------------------------- auto-réparation des problèmes mineurs connus (§7)
export async function selfHeal(db: Db) {
  const r = { sessions: 0, otp: 0, challenges: 0, logs: 0, notifications: 0, errors: 0, health: 0 };
  r.sessions = (await db.run(`DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $2)`, [iso(30), iso(30)])).changes;
  r.otp = (await db.run(`DELETE FROM otp_codes WHERE expires_at < $1`, [iso(1)])).changes;
  r.challenges = (await db.run(`DELETE FROM login_challenges WHERE expires_at < $1`, [iso(1)])).changes;
  // Rétention des journaux de connexion (durée configurable — à valider avec la réglementation applicable).
  r.logs = (await db.run(`DELETE FROM login_logs WHERE created_at < $1`, [iso(config.loginLogRetentionDays)])).changes;
  r.notifications = (await db.run(`DELETE FROM notifications WHERE created_at < $1`, [iso(90)])).changes;
  r.errors = (await db.run(`DELETE FROM error_log WHERE created_at < $1`, [iso(30)])).changes;
  r.health = (await db.run(`DELETE FROM health_checks WHERE created_at < $1`, [iso(14)])).changes;
  await purgeExpiredBlocks(db);
  return r;
}

// ----------------------------------------------------------------------------- sauvegardes (§7, §11)
// Format v2 : contenu compressé PUIS chiffré (AES-256-GCM, même clé que les champs sensibles en base) —
// une sauvegarde volée ou exfiltrée (disque, stockage objet mal configuré…) reste illisible sans ENCRYPTION_KEY.
export async function createBackup(db: Db): Promise<{ id: string; path: string; bytes: number }> {
  mkdirSync(config.backupDir, { recursive: true });
  const dump: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) dump[t] = await db.query(`SELECT * FROM ${t}`);
  const gz = gzipSync(Buffer.from(JSON.stringify({ version: 2, createdAt: nowIso(), tables: dump })));
  const buf = encryptBuffer(gz);
  const id = uid();
  const path = join(config.backupDir, `backup-${nowIso().replace(/[:.]/g, '-')}.json.gz.enc`);
  writeFileSync(path, buf, { mode: 0o600 });
  await db.run(`INSERT INTO backups (id,path,bytes,created_at) VALUES ($1,$2,$3,$4)`, [id, path, buf.length, nowIso()]);
  // Conserve les N dernières sauvegardes.
  const files = readdirSync(config.backupDir).filter((f) => f.startsWith('backup-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - config.backupKeep))) { try { unlinkSync(join(config.backupDir, f)); } catch { /* */ } }
  return { id, path, bytes: buf.length };
}

export async function listBackups(db: Db) {
  return db.query<any>(`SELECT id, path, bytes, created_at FROM backups ORDER BY created_at DESC LIMIT 30`);
}
export function backupFile(name: string): Buffer {
  const safe = basename(name);
  if (!/^backup-[\w\-]+\.json\.gz(\.enc)?$/.test(safe)) throw new Error('nom invalide');
  statSync(join(config.backupDir, safe));
  return readFileSync(join(config.backupDir, safe));
}

/** Restauration dans une base VIDE uniquement (protège contre l'écrasement accidentel). Lit le format v2 (chiffré) et l'ancien v1 (gzip seul, non chiffré) pour les sauvegardes déjà existantes. */
export async function restoreBackup(db: Db, file: string): Promise<Record<string, number>> {
  const raw = readFileSync(file);
  const gz = file.endsWith('.enc') ? decryptBuffer(raw) : raw; // compatibilité ascendante avec les sauvegardes v1 non chiffrées
  const data = JSON.parse(gunzipSync(gz).toString());
  const existing = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`))?.n ?? 0;
  if (existing > 0) throw new Error('La base n\'est pas vide : restauration refusée');
  const counts: Record<string, number> = {};
  await db.tx(async (t) => {
    for (const table of BACKUP_TABLES) {
      const rows: Record<string, unknown>[] = data.tables[table] ?? [];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.every((c) => /^[a-z_0-9]+$/.test(c))) throw new Error('colonne invalide');
        await t.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`, cols.map((c) => row[c]));
      }
      counts[table] = rows.length;
    }
  });
  return counts;
}

export async function notifyBackupFailure(db: Db, e: unknown) {
  await notifyOwner(db, 'Échec de sauvegarde automatique', String((e as Error)?.message ?? e));
}
