import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { nowIso, uid } from '../lib/util.js';
import { notifyOwner } from './notify.js';
import { verifyChain } from './security.js';
import { failTask } from './entitlements.js';

/**
 * Contrôles d'intégrité automatiques (SQL pur, sans IA, donc fiables et reproductibles).
 * Chaque contrôle détecte une anomalie. Si une correction SÛRE existe (sans toucher à de l'argent ni à des données de l'utilisateur),
 * elle est appliquée immédiatement puis le contrôle est rejoué pour confirmer. Sinon l'anomalie reste ouverte et le propriétaire est alerté
 * immédiatement (SMS inclus pour les anomalies critiques). Une anomalie déjà signalée n'est pas renotifiée à chaque passage.
 */
export type Sev = 'critical' | 'high' | 'medium' | 'low';
interface Result { ok: boolean; detail?: string }
interface Check { id: string; label: string; severity: Sev; run(db: Db, now: Date): Promise<Result>; fix?(db: Db, now: Date): Promise<string> }
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000, H = 3_600_000;
const cnt = async (db: Db, sql: string, p: unknown[] = []) => (await db.get<{ n: number }>(sql, p))?.n ?? 0;
const fmt = (rows: any[], f: (r: any) => string) => rows.slice(0, 5).map(f).join('; ') + (rows.length > 5 ? ` … (+${rows.length - 5})` : '');

export const CHECKS: Check[] = [
  { id: 'wallet_sum', label: 'Portefeuille : solde = somme du grand livre', severity: 'critical', async run(db) {
    const rows = await db.query<any>(`SELECT w.currency, w.balance AS balance, COALESCE((SELECT SUM(amount) FROM wallet_ledger l WHERE l.currency=w.currency),0) AS s FROM wallets w`);
    const bad = rows.filter((r) => Number(r.balance) !== Number(r.s)); return bad.length ? { ok: false, detail: fmt(bad, (r) => `${r.currency} : solde ${r.balance} ≠ journal ${r.s}`) } : { ok: true }; } },
  { id: 'token_sum', label: 'Jetons : solde = somme du journal', severity: 'critical', async run(db) {
    const rows = await db.query<any>(`SELECT b.user_id, b.balance AS balance, COALESCE((SELECT SUM(delta) FROM token_ledger l WHERE l.user_id=b.user_id),0) AS s FROM token_balances b`);
    const bad = rows.filter((r) => Number(r.balance) !== Number(r.s)); return bad.length ? { ok: false, detail: fmt(bad, (r) => `utilisateur ${String(r.user_id).slice(0, 8)} : solde ${r.balance} ≠ journal ${r.s}`) } : { ok: true }; } },
  { id: 'token_negative', label: 'Jetons : aucun solde négatif', severity: 'critical', async run(db) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM token_balances WHERE balance < 0`); return n ? { ok: false, detail: `${n} solde(s) négatif(s)` } : { ok: true }; } },
  { id: 'token_refund_orphans', label: 'Jetons : chaque remboursement correspond à une dépense', severity: 'high', async run(db) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM token_ledger r WHERE r.reason='refund' AND NOT EXISTS (SELECT 1 FROM token_ledger t WHERE t.reason='task' AND t.ref=r.ref AND t.user_id=r.user_id)`); return n ? { ok: false, detail: `${n} remboursement(s) sans dépense correspondante` } : { ok: true }; } },
  { id: 'payments_fulfilled', label: 'Paiements réussis : abonnement ou jetons livrés une fois', severity: 'critical', async run(db) {
    const rows = await db.query<any>(`SELECT p.provider_ref, p.plan_code FROM payments p JOIN plans pl ON pl.code=p.plan_code WHERE p.status='succeeded' AND p.user_id IS NOT NULL AND
      ((pl.features LIKE '%tokens:%' AND NOT EXISTS (SELECT 1 FROM token_ledger l WHERE l.reason='purchase' AND l.ref=p.id)) OR (pl.features NOT LIKE '%tokens:%' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.payment_id=p.id)))`);
    return rows.length ? { ok: false, detail: `Payé mais non livré : ${fmt(rows, (r) => `${r.provider_ref} (${r.plan_code})`)}` } : { ok: true }; } },
  { id: 'subscriptions_orphan', label: 'Abonnements : chacun adossé à un paiement réussi', severity: 'critical', async run(db) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM subscriptions s WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id=s.payment_id AND p.status='succeeded')`); return n ? { ok: false, detail: `${n} abonnement(s) sans paiement réussi` } : { ok: true }; } },
  { id: 'payments_stuck', label: 'Paiements en attente depuis plus de 48 h (hors SEPA)', severity: 'medium', async run(db, now) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM payments WHERE status='pending' AND channel <> 'sepa' AND created_at < $1`, [ago(now, 48 * H)]); return n ? { ok: false, detail: `${n} paiement(s) bloqué(s) en attente : vérifier le rapprochement` } : { ok: true }; } },
  { id: 'tasks_stuck', label: 'Tâches IA bloquées en cours', severity: 'high', async run(db, now) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM tasks WHERE status='running' AND created_at < $1`, [ago(now, 15 * MIN)]); return n ? { ok: false, detail: `${n} tâche(s) bloquée(s) depuis plus de 15 min` } : { ok: true }; },
    async fix(db, now) {
      const rows = await db.query<any>(`SELECT id,user_id,billing FROM tasks WHERE status='running' AND created_at < $1`, [ago(now, 15 * MIN)]);
      for (const r of rows) await failTask(db, r.user_id, { id: r.id, billing: r.billing }, 'interrompue (délai dépassé)'); return `${rows.length} tâche(s) clôturée(s), jeton ou essai restitué`; } },
  { id: 'trials_range', label: "Essais gratuits : compteur dans les bornes", severity: 'high', async run(db) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM users WHERE trials_used < 0 OR trials_used > $1`, [config.trialTasks]); return n ? { ok: false, detail: `${n} compteur(s) d'essais hors bornes` } : { ok: true }; },
    async fix(db) { await db.run(`UPDATE users SET trials_used=0 WHERE trials_used < 0`); const r = await db.run(`UPDATE users SET trials_used=$1 WHERE trials_used > $1`, [config.trialTasks]); return `compteurs ramenés dans les bornes (${r.changes} au-dessus du maximum)`; } },
  { id: 'posts_stuck', label: 'Publications bloquées en cours', severity: 'high', async run(db, now) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM social_posts WHERE status='publishing' AND updated_at < $1`, [ago(now, 10 * MIN)]); return n ? { ok: false, detail: `${n} publication(s) restée(s) « en cours »` } : { ok: true }; },
    async fix(db, now) { const r = await db.run(`UPDATE social_posts SET status='failed', error='Interrompue : vérifiez sur la plateforme si le contenu est en ligne avant de republier.', updated_at=$2 WHERE status='publishing' AND updated_at < $1`, [ago(now, 10 * MIN), nowIso()]); return `${r.changes} publication(s) marquée(s) échouée(s) SANS republication automatique`; } },
  { id: 'agent_runs_stuck', label: 'Exécutions d\'agents bloquées', severity: 'medium', async run(db, now) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM agent_runs WHERE status='running' AND started_at < $1`, [ago(now, 15 * MIN)]); return n ? { ok: false, detail: `${n} exécution(s) d'agent bloquée(s)` } : { ok: true }; },
    async fix(db, now) { const r = await db.run(`UPDATE agent_runs SET status='failed', finished_at=$2, error='interrompu (contrôle d''intégrité)' WHERE status='running' AND started_at < $1`, [ago(now, 15 * MIN), nowIso()]); return `${r.changes} exécution(s) clôturée(s)`; } },
  { id: 'oauth_states_expired', label: 'États OAuth expirés à purger', severity: 'low', async run(db, now) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM oauth_states WHERE expires_at < $1`, [ago(now, 60 * MIN)]); return n ? { ok: false, detail: `${n} état(s) expiré(s)` } : { ok: true }; },
    async fix(db, now) { const r = await db.run(`DELETE FROM oauth_states WHERE expires_at < $1`, [ago(now, 60 * MIN)]); return `${r.changes} état(s) purgé(s)`; } },
  { id: 'plan_prices', label: 'Offres actives : prix valides (multiples de 5 en XOF/XAF/CDF/GNF)', severity: 'high', async run(db) {
    const noPrice = await db.query<any>(`SELECT code FROM plans WHERE active=1 AND NOT EXISTS (SELECT 1 FROM plan_prices pp WHERE pp.plan_code=plans.code)`);
    const badMul = await db.query<any>(`SELECT plan_code, currency, amount FROM plan_prices WHERE currency IN ('XOF','XAF','CDF','GNF') AND amount % 5 <> 0`);
    const bad = await db.query<any>(`SELECT plan_code, currency, amount FROM plan_prices WHERE amount <= 0`);
    const p: string[] = []; if (noPrice.length) p.push(`sans prix : ${noPrice.map((r) => r.code).join(', ')}`); if (badMul.length) p.push(`non multiples de 5 : ${fmt(badMul, (r) => `${r.plan_code} ${r.amount} ${r.currency}`)}`); if (bad.length) p.push(`prix ≤ 0 : ${fmt(bad, (r) => `${r.plan_code} ${r.currency}`)}`);
    return p.length ? { ok: false, detail: p.join(' | ') } : { ok: true }; } },
  { id: 'security_chain', label: 'Journal de sécurité : chaîne intacte', severity: 'critical', async run(db) {
    const c = await verifyChain(db); return c.ok ? { ok: true } : { ok: false, detail: `chaîne rompue près de ${c.brokenAt ?? '?'} (${c.checked} entrées vérifiées)` }; } },
  { id: 'duplicate_phones', label: 'Un numéro de téléphone vérifié = un seul compte', severity: 'high', async run(db) {
    const n = await cnt(db, `SELECT COUNT(*) AS n FROM (SELECT phone FROM users WHERE phone_verified=1 AND phone IS NOT NULL GROUP BY phone HAVING COUNT(*) > 1) d`); return n ? { ok: false, detail: `${n} numéro(s) partagé(s) par plusieurs comptes (essais gratuits détournés ?)` } : { ok: true }; } },
  { id: 'backup_fresh', label: 'Sauvegarde logique de moins de 72 h', severity: 'medium', async run(db, now) {
    const last = await db.get<{ m: string | null }>(`SELECT MAX(created_at) AS m FROM backups`).catch(() => undefined);
    if (!last?.m) return { ok: true, detail: 'aucune sauvegarde enregistrée (contrôle non applicable)' };
    return Date.parse(last.m) < now.getTime() - 72 * H ? { ok: false, detail: `dernière sauvegarde : ${last.m}` } : { ok: true }; } },
];

export interface Report { ran: number; ok: number; fixed: { id: string; note: string }[]; open: { id: string; label: string; severity: Sev; detail: string }[]; at: string }

export async function runIntegrity(db: Db, trigger: string, now = new Date()): Promise<Report> {
  const at = nowIso(); const rep: Report = { ran: 0, ok: 0, fixed: [], open: [], at };
  for (const c of CHECKS) {
    rep.ran++;
    let r: Result;
    try { r = await c.run(db, now); } catch (e: any) { r = { ok: false, detail: `le contrôle a échoué : ${String(e?.message ?? e).slice(0, 120)}` }; }
    if (r.ok) { rep.ok++; await db.run(`UPDATE integrity_findings SET resolved_at=$2 WHERE check_id=$1 AND resolved_at IS NULL`, [c.id, at]); continue; }
    if (c.fix) { // correction sûre immédiate, puis nouveau contrôle pour confirmer
      let note = ''; try { note = await c.fix(db, now); const again = await c.run(db, now);
        if (again.ok) { rep.fixed.push({ id: c.id, note }); rep.ok++;
          await db.run(`INSERT INTO integrity_findings (id,check_id,severity,detail,first_seen,last_seen,resolved_at,auto_fixed,fix_note) VALUES ($1,$2,$3,$4,$5,$5,$5,1,$6)`, [uid(), c.id, c.severity, (r.detail ?? '').slice(0, 400), at, note.slice(0, 300)]);
          await db.run(`UPDATE integrity_findings SET resolved_at=$2 WHERE check_id=$1 AND resolved_at IS NULL`, [c.id, at]); continue; }
        r = again; } catch (e: any) { r = { ok: false, detail: `${r.detail} (correction impossible : ${String(e?.message ?? e).slice(0, 100)})` }; }
    }
    const open = await db.get<{ id: string; notified_at: string | null }>(`SELECT id, notified_at FROM integrity_findings WHERE check_id=$1 AND resolved_at IS NULL`, [c.id]);
    rep.open.push({ id: c.id, label: c.label, severity: c.severity, detail: r.detail ?? '' });
    if (open) await db.run(`UPDATE integrity_findings SET last_seen=$2, detail=$3 WHERE id=$1`, [open.id, at, (r.detail ?? '').slice(0, 400)]);
    else {
      const id = uid();
      await db.run(`INSERT INTO integrity_findings (id,check_id,severity,detail,first_seen,last_seen,auto_fixed,notified_at) VALUES ($1,$2,$3,$4,$5,$5,0,$5)`, [id, c.id, c.severity, (r.detail ?? '').slice(0, 400), at]);
      // Alerte IMMÉDIATE à la première détection (SMS pour les anomalies critiques).
      await notifyOwner(db, `ANOMALIE ${c.severity.toUpperCase()} : ${c.label}`, `${r.detail}\n\nDéclenchement : ${trigger}. À traiter dans Administration › Contrôles.`, { sms: c.severity === 'critical' }).catch(() => undefined);
    }
  }
  return rep;
}

export async function integritySummary(db: Db) {
  const open = await db.query<any>(`SELECT check_id, severity, detail, first_seen, last_seen FROM integrity_findings WHERE resolved_at IS NULL ORDER BY first_seen`);
  const fixed = await db.query<any>(`SELECT check_id, severity, detail, fix_note, resolved_at FROM integrity_findings WHERE auto_fixed=1 ORDER BY resolved_at DESC LIMIT 20`);
  return { checks: CHECKS.map((c) => ({ id: c.id, label: c.label, severity: c.severity, autoFix: !!c.fix, open: open.find((o) => o.check_id === c.id) ?? null })), open, recentlyFixed: fixed };
}
