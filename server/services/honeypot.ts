import type { Db } from '../db/index.js';
import { config } from '../config.js';
import type { Req } from '../lib/http.js';
import { ipPrefix } from '../lib/http.js';
import { nowIso, uid } from '../lib/util.js';
import { blockIp, logEvent } from './security.js';

/**
 * Piège anti-intrusion (« boîte »).
 *
 * Principe : des routes et paramètres qui n'existent dans AUCUNE interface légitime de Velyra sont exposés
 * (fausses routes « admin », faux endpoints d'export de portefeuille, faux fichiers de configuration…).
 * Un utilisateur normal ne peut jamais y accéder par hasard — en revanche, c'est exactement ce que cherche
 * un balayage automatisé ou une tentative d'intrusion manuelle.
 *
 * Dès qu'une requête touche l'un de ces pièges :
 *  1. l'IP est immédiatement et durablement bloquée (toute nouvelle requête reçoit 403, quoi qu'elle tente) ;
 *  2. le propriétaire est alerté sur-le-champ (email + SMS, severity « critical ») ;
 *  3. les informations techniques captées (IP, user-agent, chemin, empreinte d'appareil) sont stockées
 *     séparément pour être purgées automatiquement 10 jours plus tard (purgeHoneypot, appelé par jobs.ts) ;
 *  4. l'intrus reçoit une réponse qui ressemble à un succès plausible (sans aucune donnée réelle), afin qu'il
 *     croie avoir réussi et cesse de chercher ailleurs — pendant que le système réel n'a absolument pas bougé.
 *
 * Ce mécanisme n'interagit jamais avec l'appareil de l'intrus : il ne fait que répondre, comme toute page web,
 * à la requête que l'intrus a lui-même envoyée à notre serveur.
 */

// Routes-pièges : jamais appelées par le vrai frontend, jamais documentées dans l'API publique.
export const HONEYPOT_PATHS = [
  '/api/admin/export-wallet-keys',
  '/api/admin/backup/full-download',
  '/api/admin/users/export-all',
  '/api/admin/debug',
  '/api/internal/debug',
  '/api/internal/config',
  '/api/_debug',
  '/api/admin/.env',
  '/api/v2/admin/login', // fausse version « v2 » plausible, jamais utilisée
  '/api/admin/seed-database',
];
const HONEYPOT_SET = new Set(HONEYPOT_PATHS);
export const isHoneypot = (path: string) => HONEYPOT_SET.has(path.replace(/\/+$/, ''));

export async function springTrap(db: Db, r: Req): Promise<{ status: number; body: unknown }> {
  const ip = r.ip;
  await db.run(
    `INSERT INTO honeypot_hits (id,ip,ip_prefix,path,method,user_agent,device_hash,headers,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uid(), ip, ipPrefix(ip), r.path.slice(0, 300), r.method, r.ua.slice(0, 300), r.deviceHash, JSON.stringify({ authorization: r.headers.authorization ? '(présent)' : null, 'x-api-key': r.headers['x-api-key'] ? '(présent)' : null }), nowIso()],
  );
  // Blocage immédiat et durable (pas d'attente de seuil, contrairement aux sondages ordinaires) + alerte critique sur-le-champ.
  await blockIp(db, ip, `Piège anti-intrusion déclenché : ${r.path}`, { permanent: false, hours: config.ipBlockHours * 10 });
  await logEvent(db, 'honeypot_triggered', 'critical', { ip, detail: { path: r.path, method: r.method, ua: r.ua.slice(0, 200) } });
  // Réponse plausible mais entièrement fictive : ne révèle, ne modifie et ne transmet aucune donnée réelle.
  return { status: 200, body: { ok: true, status: 'queued', jobId: uid() } };
}

/** Purge automatique des informations captées, au-delà de la durée de rétention configurée (10 jours par défaut). */
export async function purgeHoneypot(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - config.honeypotRetentionDays * 86_400_000).toISOString();
  const r = await db.run(`DELETE FROM honeypot_hits WHERE created_at < $1`, [cutoff]);
  return r.changes;
}

export async function recentHits(db: Db, limit = 100) {
  return db.query(`SELECT id,ip,ip_prefix,path,method,user_agent,created_at FROM honeypot_hits ORDER BY created_at DESC LIMIT $1`, [limit]);
}
