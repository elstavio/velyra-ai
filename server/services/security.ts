import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { ipPrefix } from '../lib/http.js';
import { hit, peek } from '../lib/ratelimit.js';
import { addDays, nowIso, uid } from '../lib/util.js';
import { notifyEmail, notifyOwner } from './notify.js';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

// --- cache mémoire des IP bloquées (évite une requête SQL à chaque appel) -------------------------
const blocked = new Map<string, number | 'forever'>();
export async function loadBlocks(db: Db) {
  blocked.clear();
  const rows = await db.query<{ ip: string; permanent: number; expires_at: string | null }>(`SELECT ip, permanent, expires_at FROM ip_blocks`);
  for (const r of rows) blocked.set(r.ip, r.permanent ? 'forever' : Date.parse(r.expires_at ?? '') || 0);
}
export function isBlocked(ip: string, now = Date.now()): boolean {
  const v = blocked.get(ip);
  if (v === undefined) return false;
  if (v === 'forever' || v > now) return true;
  blocked.delete(ip);
  return false;
}

// --- journal de sécurité chaîné par hachage (preuves techniques horodatées, §8) -----------------
let chain: Promise<unknown> = Promise.resolve();
export function logEvent(db: Db, type: string, severity: Severity, o: { ip?: string; userId?: string | null; detail?: Record<string, unknown> | string } = {}): Promise<void> {
  const run = async () => {
    const head = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key='sec_chain_head'`);
    const prev = head?.value ?? 'GENESIS';
    const id = uid(), at = nowIso();
    const detail = typeof o.detail === 'string' ? o.detail : JSON.stringify(o.detail ?? {});
    const hash = sha256([prev, id, type, severity, o.ip ?? '', o.userId ?? '', detail, at].join('|'));
    await db.run(`INSERT INTO security_events (id,type,severity,ip,user_id,detail,created_at,prev_hash,hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, type, severity, o.ip ?? null, o.userId ?? null, detail, at, prev, hash]);
    await db.run(`INSERT INTO settings (key,value) VALUES ('sec_chain_head',$1) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [hash]);
    if (severity === 'high' || severity === 'critical') {
      await notifyOwner(db, `Alerte sécurité (${severity}) : ${type}`, `IP : ${o.ip ?? '-'}\nUtilisateur : ${o.userId ?? '-'}\nDétail : ${detail}\nHorodatage : ${at}`, { sms: severity === 'critical' });
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next as Promise<void>;
}

/** Vérifie l'intégrité de la chaîne : retourne l'identifiant du premier maillon altéré, ou null. */
export async function verifyChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAt?: string }> {
  const rows = await db.query<any>(`SELECT * FROM security_events ORDER BY created_at, id`);
  // L'ordre d'insertion = ordre de la chaîne : on suit prev_hash plutôt que le tri temporel.
  const byPrev = new Map(rows.map((r) => [r.prev_hash, r]));
  let prev = 'GENESIS', n = 0;
  for (;;) {
    const r = byPrev.get(prev);
    if (!r) break;
    const h = sha256([prev, r.id, r.type, r.severity, r.ip ?? '', r.user_id ?? '', r.detail ?? '', r.created_at].join('|'));
    if (h !== r.hash) return { ok: false, checked: n, brokenAt: r.id };
    prev = r.hash; n++;
  }
  return n === rows.length ? { ok: true, checked: n } : { ok: false, checked: n, brokenAt: 'chaîne incomplète' };
}

export async function blockIp(db: Db, ip: string, reason: string, { permanent = false, hours = config.ipBlockHours, by = 'system' } = {}) {
  const expires = permanent ? null : new Date(Date.now() + hours * 3_600_000).toISOString();
  await db.run(`INSERT INTO ip_blocks (ip,reason,permanent,created_at,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (ip) DO UPDATE SET reason=excluded.reason, permanent=excluded.permanent, expires_at=excluded.expires_at, created_by=excluded.created_by`,
    [ip, reason, permanent ? 1 : 0, nowIso(), expires, by]);
  blocked.set(ip, permanent ? 'forever' : Date.parse(expires!));
  await logEvent(db, 'ip_blocked', 'high', { ip, detail: { reason, permanent, expires } });
  // Réponse automatisée BORNÉE (§ réponse aux incidents) : toute session active déjà ouverte depuis cette IP est
  // révoquée immédiatement — c'est du confinement (containment), jamais une action sur l'argent, les droits d'un
  // compte ou le contenu d'un utilisateur. Aucune élévation de privilèges n'a lieu nulle part dans ce chemin.
  await revokeSessionsForIp(db, ip, `session révoquée automatiquement : IP ${ip} bloquée (${reason})`);
}

/** Confinement borné : révoque toute session active ouverte depuis une IP qui vient d'être bloquée. Ne touche jamais
 * aux comptes, à l'argent ni aux droits — uniquement la session elle-même, et seulement celles liées à cette IP précise. */
export async function revokeSessionsForIp(db: Db, ip: string, reason: string) {
  const rows = await db.query<{ id: string; user_id: string; is_admin: number }>(`SELECT id,user_id,is_admin FROM sessions WHERE ip=$1 AND revoked_at IS NULL AND expires_at > $2`, [ip, nowIso()]);
  if (!rows.length) return;
  await db.run(`UPDATE sessions SET revoked_at=$2 WHERE ip=$1 AND revoked_at IS NULL`, [ip, nowIso()]);
  for (const r of rows) await logEvent(db, 'session_auto_revoked', r.is_admin ? 'critical' : 'high', { ip, userId: r.user_id, detail: { reason, sessionId: r.id } });
}

// --- détection comportementale par corrélation (plusieurs signaux faibles distincts depuis la même IP) -----------
// Règles simples et explicites (pas un modèle de machine learning) : si une même IP cumule PLUSIEURS catégories
// différentes de signal suspect en moins de 10 minutes, c'est traité comme une attaque probable plutôt que comme
// des incidents isolés, et l'IP est bloquée (avec révocation de session en cascade via blockIp ci-dessus).
export type ThreatSignal = 'probe' | 'failed_login' | 'waf_rejected' | 'webauthn_failed' | 'admin_2fa_failed' | 'honeypot';
const SIGNAL_WINDOW_MS = 10 * 60_000;
const signals = new Map<string, { kinds: Set<ThreatSignal>; at: number }>();
function pruneSignals(now: number) { for (const [k, v] of signals) if (now - v.at > SIGNAL_WINDOW_MS) signals.delete(k); }

export async function recordSecuritySignal(db: Db, ip: string, kind: ThreatSignal) {
  const now = Date.now();
  pruneSignals(now);
  let e = signals.get(ip);
  if (!e || now - e.at > SIGNAL_WINDOW_MS) { e = { kinds: new Set(), at: now }; signals.set(ip, e); }
  e.kinds.add(kind); e.at = now;
  if (e.kinds.size >= 3 && !isBlocked(ip)) {
    const kinds = [...e.kinds];
    signals.delete(ip);
    await logEvent(db, 'correlated_threat_detected', 'critical', { ip, detail: { kinds } });
    await blockIp(db, ip, `Activité suspecte corrélée (${kinds.join(', ')}) en moins de 10 minutes`);
  }
}
export async function unblockIp(db: Db, ip: string) {
  await db.run(`DELETE FROM ip_blocks WHERE ip=$1`, [ip]);
  blocked.delete(ip);
}

// --- détection ------------------------------------------------------------------------------------
/** Échec de connexion : compteur par IP ; blocage automatique seulement après un volume d'échecs avéré. */
export async function recordFailedLogin(db: Db, ip: string, userId: string | null, reason: string) {
  const r = hit(`fail:${ip}`, 1_000_000, 600_000);
  if (r.count === Math.ceil(config.ipBlockFailedLogins / 2)) await logEvent(db, 'login_failures_rising', 'medium', { ip, userId, detail: { count: r.count, reason } });
  if (r.count >= config.ipBlockFailedLogins && !isBlocked(ip)) {
    await blockIp(db, ip, `${r.count} échecs de connexion en 10 min`);
  }
  await recordSecuritySignal(db, ip, 'failed_login');
}

const PROBE_RE = /(^\/\.(env|git|aws|ssh)|wp-admin|wp-login|phpmyadmin|\/etc\/passwd|\.php$|\/vendor\/|\/cgi-bin|\.\.\/|%2e%2e)/i;
export const looksLikeProbe = (path: string) => PROBE_RE.test(path);

export async function recordProbe(db: Db, ip: string, path: string) {
  const r = hit(`probe:${ip}`, 1_000_000, 600_000);
  if (r.count === 1) await logEvent(db, 'path_probe', 'low', { ip, detail: { path: path.slice(0, 200) } });
  if (r.count >= config.ipBlockProbeHits && !isBlocked(ip)) await blockIp(db, ip, `Sondage répété de chemins sensibles (${r.count})`);
  await recordSecuritySignal(db, ip, 'probe');
}

export const failuresInWindow = (ip: string) => peek(`fail:${ip}`, 600_000);

// --- alerte « appareil / IP inconnu » (§8) ---------------------------------------------------------
/**
 * À chaque connexion réussie d'un utilisateur, vérifie si l'appareil (empreinte envoyée par le frontend,
 * en-tête X-Device-Id) est déjà connu pour ce compte. Si non, l'utilisateur est averti par email — c'est le
 * signal le plus fiable dont on dispose sans service tiers payant d'intelligence IP (une IP seule ne permet
 * pas, à elle seule et de façon fiable, de distinguer un VPN légitime d'un usage normal ; voir le README).
 */
export async function checkAndRecordDevice(db: Db, u: { id: string; email: string }, ip: string, ua: string, deviceHash: string | null) {
  const prefix = ipPrefix(ip);
  if (!deviceHash) {
    await logEvent(db, 'login_no_device_id', 'info', { ip, userId: u.id });
    return;
  }
  const known = await db.get<{ ip_prefix: string | null }>(`SELECT ip_prefix FROM known_devices WHERE user_id=$1 AND device_hash=$2`, [u.id, deviceHash]);
  await db.run(
    `INSERT INTO known_devices (user_id,device_hash,ip_prefix,first_seen,last_seen) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (user_id,device_hash) DO UPDATE SET ip_prefix=excluded.ip_prefix, last_seen=excluded.last_seen`,
    [u.id, deviceHash, prefix, nowIso()],
  );
  if (!known) {
    await logEvent(db, 'new_device_login', 'medium', { ip, userId: u.id, detail: { ua: ua.slice(0, 200) } });
    await notifyEmail(
      db, u.email, '[Velyra AI] Nouvelle connexion détectée',
      `Une connexion vient d'avoir lieu sur votre compte Velyra AI depuis un appareil que nous ne reconnaissons pas.\n\nAdresse IP : ${ip}\nAppareil/navigateur : ${ua.slice(0, 150) || 'inconnu'}\nDate : ${nowIso()}\n\nSi c'est bien vous, aucune action n'est nécessaire.\nSi ce n'est pas vous : changez votre mot de passe immédiatement et révoquez les autres sessions depuis Paramètres → Sécurité.`,
    );
  }
}

export async function purgeExpiredBlocks(db: Db) {
  await db.run(`DELETE FROM ip_blocks WHERE permanent=0 AND expires_at < $1`, [nowIso()]);
}
export { addDays };
