import type { Db } from '../db/index.js';
import { nowIso, uid, HttpError, parseJson } from '../lib/util.js';
import { audit } from './admin.js';

/**
 * Moteur d'analyse (§6). Il travaille UNIQUEMENT sur des agrégats anonymes (comptages par jour), jamais sur le contenu
 * des utilisateurs. Ce sont des statistiques (moyenne/écart-type glissants, ratios), pas un modèle d'apprentissage
 * automatique : il apprend des seuils à partir de l'historique, et PROPOSE des améliorations que le propriétaire valide.
 */
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const DAYS = 14;

async function perDay(db: Db, sql: string): Promise<number[]> {
  const from = dayStr(new Date(Date.now() - (DAYS - 1) * 86_400_000));
  const rows = await db.query<{ d: string; n: number }>(sql, [from]);
  const m = new Map(rows.map((r) => [r.d, r.n]));
  return Array.from({ length: DAYS }, (_, i) => m.get(dayStr(new Date(Date.now() - (DAYS - 1 - i) * 86_400_000))) ?? 0);
}

export function zScore(series: number[]): { z: number; mean: number; sd: number; last: number } {
  const hist = series.slice(0, -1), last = series[series.length - 1];
  const mean = hist.reduce((a, b) => a + b, 0) / Math.max(1, hist.length);
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, hist.length));
  const z = sd === 0 ? (last > mean + 3 ? 99 : 0) : (last - mean) / sd;
  return { z, mean, sd, last };
}

interface Draft { kind: string; title: string; detail: string; evidence: unknown; key: string }

export async function runInsights(db: Db): Promise<{ runId: string; anomalies: number; proposalsCreated: number; metrics: any }> {
  const runId = uid();
  await db.run(`INSERT INTO ai_runs (id,started_at) VALUES ($1,$2)`, [runId, nowIso()]);
  const signups = await perDay(db, `SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM users WHERE role='user' AND created_at >= $1 GROUP BY substr(created_at,1,10)`);
  const paid = await perDay(db, `SELECT substr(confirmed_at,1,10) AS d, COUNT(*) AS n FROM payments WHERE status='succeeded' AND confirmed_at >= $1 GROUP BY substr(confirmed_at,1,10)`);
  const failed = await perDay(db, `SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM payments WHERE status='failed' AND created_at >= $1 GROUP BY substr(created_at,1,10)`);
  const tasks = await perDay(db, `SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM tasks WHERE created_at >= $1 GROUP BY substr(created_at,1,10)`);
  const errors = await perDay(db, `SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM error_log WHERE created_at >= $1 GROUP BY substr(created_at,1,10)`);
  const metrics: Record<string, any> = { signups: zScore(signups), payments: zScore(paid), failedPayments: zScore(failed), tasks: zScore(tasks), errors: zScore(errors) };

  const drafts: Draft[] = [];
  const day = dayStr(new Date());
  if (metrics.signups.z >= 3 && metrics.signups.last >= 10)
    drafts.push({ kind: 'anomaly', key: `signups:${day}`, title: 'Pic anormal d\'inscriptions', detail: `${metrics.signups.last} inscriptions aujourd'hui contre ${metrics.signups.mean.toFixed(1)} en moyenne. Vérifiez la file « Signalements » (revue humaine) : il peut s'agir d'un abus ou d'une campagne légitime.`, evidence: metrics.signups });
  if (metrics.errors.z >= 3 && metrics.errors.last >= 5)
    drafts.push({ kind: 'anomaly', key: `errors:${day}`, title: 'Hausse des erreurs serveur', detail: `${metrics.errors.last} erreurs aujourd'hui (moyenne ${metrics.errors.mean.toFixed(1)}). Consultez Système > Erreurs récentes.`, evidence: metrics.errors });

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const ratios = await db.query<{ channel: string; ok: number; ko: number }>(`SELECT channel, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS ko FROM payments WHERE created_at >= $1 GROUP BY channel`, [since]);
  for (const r of ratios) {
    const n = r.ok + r.ko;
    if (n >= 5 && r.ko / n >= 0.4)
      drafts.push({ kind: 'payments', key: `failrate:${r.channel}:${day}`, title: `Taux d'échec élevé sur « ${r.channel} »`, detail: `${r.ko} paiements échoués sur ${n} ces dernières 24 h (${Math.round((100 * r.ko) / n)} %). Vérifiez l'état de l'opérateur/agrégateur ou proposez un autre moyen de paiement.`, evidence: r });
  }

  const conv = await db.get<{ exhausted: number; payers: number }>(`SELECT (SELECT COUNT(*) FROM users WHERE role='user' AND trials_used >= 5) AS exhausted, (SELECT COUNT(DISTINCT user_id) FROM subscriptions) AS payers`);
  if (conv && conv.exhausted >= 20 && conv.payers / conv.exhausted < 0.05)
    drafts.push({ kind: 'growth', key: `conversion:${day.slice(0, 7)}`, title: 'Faible conversion essai → abonnement', detail: `${conv.exhausted} utilisateurs ont épuisé leurs essais ; ${conv.payers} ont payé (${((100 * conv.payers) / conv.exhausted).toFixed(1)} %). Pistes : offre d'entrée moins chère, rappel par email, moyens de paiement locaux plus visibles. Changement de prix = validation du propriétaire.`, evidence: conv });

  const pf = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payouts WHERE status IN ('failed','abandoned','review')`))?.n ?? 0;
  if (pf > 0) drafts.push({ kind: 'payouts', key: `payouts:${day}`, title: 'Transferts en difficulté', detail: `${pf} transfert(s) vers votre compte de réception sont en échec ou à vérifier. Les fonds restent dans le wallet. Vérifiez la configuration (numéro, solde CinetPay, validation par email/IP autorisée).`, evidence: { count: pf } });

  let created = 0;
  for (const d of drafts) {
    const exists = await db.get(`SELECT id FROM ai_proposals WHERE fingerprint=$1`, [d.key]);
    if (exists) continue;
    await db.run(`INSERT INTO ai_proposals (id,kind,title,detail,evidence,fingerprint,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`, [uid(), d.kind, d.title, d.detail, JSON.stringify(d.evidence), d.key, nowIso()]);
    created++;
  }
  await db.run(`UPDATE ai_runs SET finished_at=$2, metrics=$3, anomalies=$4, proposals_created=$5 WHERE id=$1`, [runId, nowIso(), JSON.stringify(metrics), drafts.length, created]);
  return { runId, anomalies: drafts.length, proposalsCreated: created, metrics };
}

export async function listProposals(db: Db, status?: string) {
  const rows = await db.query<any>(`SELECT id,kind,title,detail,evidence,status,created_at,decided_at FROM ai_proposals ${status ? 'WHERE status=$1' : ''} ORDER BY created_at DESC LIMIT 100`, status ? [status] : []);
  return rows.map((r) => ({ ...r, evidence: parseJson(r.evidence, null) }));
}
/** Aucune proposition n'est appliquée automatiquement : approuver = acter la décision du propriétaire. */
export async function decideProposal(db: Db, adminId: string, id: string, decision: unknown) {
  if (!['approved', 'rejected'].includes(String(decision))) throw new HttpError(400, 'invalid_decision', 'approved ou rejected');
  const r = await db.run(`UPDATE ai_proposals SET status=$2, decided_at=$3, decided_by=$4 WHERE id=$1 AND status='pending'`, [id, String(decision), nowIso(), adminId]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Proposition introuvable ou déjà traitée');
  await audit(db, adminId, `ai_proposal_${decision}`, id);
}
