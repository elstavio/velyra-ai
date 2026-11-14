import type { Db } from '../db/index.js';
import { nowIso, uid, HttpError, bad, parseJson, str } from '../lib/util.js';
import { revokeAllSessions } from './auth.js';
import { balances } from './wallet.js';
import { logEvent } from './security.js';

export async function audit(db: Db, actorId: string | null, action: string, target?: string, detail?: unknown) {
  await db.run(`INSERT INTO audit_log (id,actor_id,action,target,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [uid(), actorId, action, target ?? null, detail ? JSON.stringify(detail).slice(0, 1000) : null, nowIso()]);
}

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

export async function revenueSeries(db: Db, days = 90) {
  const from = dayStr(new Date(Date.now() - days * 86_400_000));
  const rows = await db.query<{ d: string; currency: string; total: number; n: number }>(
    `SELECT substr(confirmed_at,1,10) AS d, currency, SUM(amount) AS total, COUNT(*) AS n FROM payments WHERE status='succeeded' AND confirmed_at >= $1 GROUP BY substr(confirmed_at,1,10), currency ORDER BY d`, [from]);
  const now = Date.now();
  const sum = (since: string) => {
    const m: Record<string, number> = {};
    for (const r of rows) if (r.d >= since) m[r.currency] = (m[r.currency] ?? 0) + r.total;
    return m;
  };
  return {
    daily: rows,
    today: sum(dayStr(new Date(now))), last7days: sum(dayStr(new Date(now - 6 * 86_400_000))), last30days: sum(dayStr(new Date(now - 29 * 86_400_000))),
  };
}

export async function dashboard(db: Db) {
  const num = async (sql: string, p: unknown[] = []) => (await db.get<{ n: number }>(sql, p))?.n ?? 0;
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const [users, verified, newToday, activeSessions, fraudOpen, pendingPay, failedPayouts, heldPayouts] = await Promise.all([
    num(`SELECT COUNT(*) AS n FROM users WHERE role='user'`),
    num(`SELECT COUNT(*) AS n FROM users WHERE role='user' AND email_verified=1`),
    num(`SELECT COUNT(*) AS n FROM users WHERE role='user' AND created_at >= $1`, [since24h]),
    num(`SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > $1`, [nowIso()]),
    num(`SELECT COUNT(*) AS n FROM fraud_reports WHERE status='open'`),
    num(`SELECT COUNT(*) AS n FROM payments WHERE status='pending'`),
    num(`SELECT COUNT(*) AS n FROM payouts WHERE status IN ('failed','abandoned','review')`),
    num(`SELECT COUNT(*) AS n FROM payouts WHERE status='held'`),
  ]);
  const byCountry = await db.query<{ country: string | null; n: number }>(`SELECT country, COUNT(*) AS n FROM users WHERE role='user' GROUP BY country ORDER BY n DESC`);
  const recentPayments = await db.query<any>(`SELECT provider_ref, plan_code, amount, currency, status, channel, country, fraud_flag, created_at FROM payments ORDER BY created_at DESC LIMIT 15`);
  const alerts = await db.query<any>(`SELECT id,type,severity,ip,detail,created_at FROM security_events WHERE severity IN ('medium','high','critical') ORDER BY created_at DESC LIMIT 15`);
  const conv = await db.get<{ trial: number; paid: number }>(`SELECT (SELECT COUNT(*) FROM users WHERE role='user' AND trials_used>=1) AS trial, (SELECT COUNT(DISTINCT user_id) FROM subscriptions WHERE user_id IS NOT NULL) AS paid`);
  const ai = await db.get<any>(`SELECT (SELECT COUNT(*) FROM ai_proposals WHERE status='pending') AS pending, (SELECT MAX(finished_at) FROM ai_runs) AS last_run`);
  const tasks24 = await num(`SELECT COUNT(*) AS n FROM tasks WHERE created_at >= $1`, [since24h]);
  return {
    users: { total: users, verified, newLast24h: newToday, byCountry, tried: conv?.trial ?? 0, paying: conv?.paid ?? 0 },
    revenue: await revenueSeries(db, 90),
    activeSessions, pendingPayments: pendingPay, fraudOpen, payouts: { problems: failedPayouts, held: heldPayouts },
    wallets: await balances(db), recentPayments, securityAlerts: alerts,
    aiStats: { pendingProposals: ai?.pending ?? 0, lastRun: ai?.last_run ?? null, tasksLast24h: tasks24 },
  };
}

export async function listUsers(db: Db, q: { query?: string; status?: string; page?: number }) {
  const page = Math.max(1, q.page ?? 1), size = 25;
  const where: string[] = [`role='user'`]; const p: unknown[] = [];
  if (q.query) { p.push(`%${q.query.toLowerCase()}%`); where.push(`email LIKE $${p.length}`); }
  if (q.status) { p.push(q.status); where.push(`status=$${p.length}`); }
  const total = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE ${where.join(' AND ')}`, p))?.n ?? 0;
  p.push(size, (page - 1) * size);
  const rows = await db.query<any>(`SELECT id,email,status,country,email_verified,phone_verified,trials_used,created_at,last_login_at,extra_verification FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
  return { total, page, pageSize: size, users: rows };
}

export async function setUserStatus(db: Db, adminId: string, userId: string, status: string, reason: string) {
  if (!['active', 'suspended', 'revoked'].includes(status)) throw bad('invalid_status', 'Statut inconnu');
  const u = await db.get<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [userId]);
  if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
  if (u.role === 'admin') throw new HttpError(403, 'forbidden', 'Action impossible sur un administrateur');
  await db.run(`UPDATE users SET status=$2, updated_at=$3 WHERE id=$1`, [userId, status, nowIso()]);
  if (status !== 'active') await revokeAllSessions(db, userId);
  await audit(db, adminId, `user_${status}`, userId, { reason });
  await logEvent(db, `user_${status}`, status === 'revoked' ? 'medium' : 'info', { userId, detail: { by: adminId, reason } });
}

// ---------------------------------------------------------------- fraude : signalement manuel + revue humaine (§2)
export async function reportFraud(db: Db, reporterId: string, userId: string, reason: string) {
  const exists = await db.get(`SELECT id FROM users WHERE id=$1`, [userId]);
  if (!exists) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
  const id = uid();
  await db.run(`INSERT INTO fraud_reports (id,user_id,reporter_id,source,reason,created_at) VALUES ($1,$2,$3,'manual',$4,$5)`, [id, userId, reporterId, str(reason, 'motif', { min: 3, max: 500 }), nowIso()]);
  return id;
}
export async function listFraud(db: Db, status = 'open') {
  return db.query<any>(`SELECT f.*, u.email AS user_email, u.status AS user_status FROM fraud_reports f LEFT JOIN users u ON u.id=f.user_id WHERE f.status=$1 ORDER BY f.created_at DESC LIMIT 100`, [status]);
}
/** Aucune suspension automatique : un humain tranche. */
export async function reviewFraud(db: Db, adminId: string, id: string, b: { decision: unknown; suspend?: unknown; note?: unknown }) {
  const decision = String(b.decision);
  if (!['confirm', 'dismiss'].includes(decision)) throw bad('invalid_decision', 'Décision : confirm ou dismiss');
  const f = await db.get<any>(`SELECT * FROM fraud_reports WHERE id=$1`, [id]);
  if (!f) throw new HttpError(404, 'not_found', 'Signalement introuvable');
  if (f.status !== 'open') throw new HttpError(409, 'already_reviewed', 'Déjà traité');
  await db.run(`UPDATE fraud_reports SET status=$2, reviewed_by=$3, reviewed_at=$4, resolution=$5 WHERE id=$1`, [id, decision === 'confirm' ? 'confirmed' : 'dismissed', adminId, nowIso(), String(b.note ?? '').slice(0, 500)]);
  if (decision === 'confirm' && b.suspend === true) await setUserStatus(db, adminId, f.user_id, 'suspended', `fraude confirmée (${id})`);
  await audit(db, adminId, `fraud_${decision}`, id);
}

export async function listPayments(db: Db, status?: string, flagged?: boolean) {
  const where: string[] = []; const p: unknown[] = [];
  if (status) { p.push(status); where.push(`p.status=$${p.length}`); }
  if (flagged) where.push(`p.fraud_flag=1`);
  return db.query<any>(`SELECT p.id,p.provider_ref,p.plan_code,p.amount,p.currency,p.country,p.channel,p.status,p.fraud_flag,p.fraud_reasons,p.created_at,p.confirmed_at,u.email FROM payments p LEFT JOIN users u ON u.id=p.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.created_at DESC LIMIT 200`, p);
}

export async function walletOverview(db: Db) {
  return {
    balances: await balances(db),
    ledger: await db.query<any>(`SELECT id,currency,kind,amount,balance_after,payment_id,payout_id,note,created_at FROM wallet_ledger ORDER BY created_at DESC LIMIT 100`),
    payouts: await db.query<any>(`SELECT id,payment_id,currency,amount,channel,status,attempts,next_attempt_at,last_error,created_at,updated_at FROM payouts ORDER BY created_at DESC LIMIT 100`),
  };
}

export async function setPlanPrice(db: Db, adminId: string, planCode: string, currency: string, amount: number) {
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('invalid_currency', 'Devise invalide');
  if (!Number.isInteger(amount) || amount <= 0) throw bad('invalid_amount', 'Montant invalide');
  if (currency !== 'USD' && currency !== 'EUR' && amount % 5 !== 0) throw bad('invalid_amount', 'Le montant doit être un multiple de 5 (exigence CinetPay hors USD)');
  const plan = await db.get(`SELECT code FROM plans WHERE code=$1`, [planCode]);
  if (!plan) throw new HttpError(404, 'not_found', 'Offre inconnue');
  await db.run(`INSERT INTO plan_prices (plan_code,currency,amount) VALUES ($1,$2,$3) ON CONFLICT (plan_code,currency) DO UPDATE SET amount=excluded.amount`, [planCode, currency, amount]);
  await audit(db, adminId, 'plan_price', planCode, { currency, amount });
}

export function revenueCsv(rows: { d: string; currency: string; total: number; n: number }[]): string {
  return 'date,devise,total,nombre_paiements\n' + rows.map((r) => `${r.d},${r.currency},${r.total},${r.n}`).join('\n') + '\n';
}

export { parseJson };
