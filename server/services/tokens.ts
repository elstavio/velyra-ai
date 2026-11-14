import type { Db } from '../db/index.js';
import { HttpError, bad, nowIso, uid } from '../lib/util.js';
import { notifyEmail } from './notify.js';

/**
 * Jetons : 1 jeton = 1 tâche d'IA. Ils n'expirent jamais (aucune date de péremption n'existe dans le code).
 * Ils ne sont consommés qu'après l'abonnement (usage équitable) et les essais gratuits. Journal append-only : la somme du journal
 * doit toujours égaler le solde (vérifié chaque jour par les contrôles d'intégrité).
 */
export const LOW_BALANCE = 10;

export async function getBalance(db: Db, userId: string): Promise<number> {
  return (await db.get<{ balance: number }>(`SELECT balance FROM token_balances WHERE user_id=$1`, [userId]))?.balance ?? 0;
}

/** À appeler dans une transaction. `reason`+`ref` uniques : un même paiement ou une même tâche ne peut créditer qu'une fois. */
export async function credit(t: Db, userId: string, n: number, reason: string, ref: string | null, note?: string): Promise<number> {
  if (!Number.isInteger(n) || n === 0) throw bad('invalid_amount', 'Quantité de jetons invalide');
  const now = nowIso();
  const r = await t.run(`UPDATE token_balances SET balance = balance + $2, updated_at=$3 WHERE user_id=$1 AND balance + $2 >= 0`, [userId, n, now]);
  if (!r.changes) {
    if (n < 0) throw new HttpError(409, 'insufficient_tokens', 'Solde de jetons insuffisant');
    await t.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ($1,$2,$3)`, [userId, n, now]);
  }
  const bal = (await t.get<{ balance: number }>(`SELECT balance FROM token_balances WHERE user_id=$1`, [userId]))!.balance;
  await t.run(`INSERT INTO token_ledger (id,user_id,delta,balance_after,reason,ref,note,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [uid(), userId, n, bal, reason, ref, note ?? null, now]);
  return bal;
}

/** Dépense atomique d'un jeton pour une tâche ; retourne false si le solde est vide. */
export async function spendOne(db: Db, userId: string, taskId: string, email?: string): Promise<boolean> {
  let bal: number;
  try { bal = await db.tx((t) => credit(t, userId, -1, 'task', taskId)); } catch (e: any) { if (e?.code === 'insufficient_tokens') return false; throw e; }
  if (email && (bal === LOW_BALANCE || bal === 0)) {
    await notifyEmail(db, email, bal === 0 ? 'Velyra AI : vos jetons sont épuisés' : `Velyra AI : il vous reste ${bal} jetons`, bal === 0
      ? "Vous avez utilisé votre dernier jeton. Rechargez depuis la page Offres pour continuer à utiliser les agents IA. Vos jetons n'expirent jamais."
      : `Il vous reste ${bal} jetons. Pensez à recharger depuis la page Offres. Vos jetons n'expirent jamais.`).catch(() => undefined);
  }
  return true;
}

export async function refundOne(db: Db, userId: string, taskId: string) {
  await db.tx((t) => credit(t, userId, 1, 'refund', taskId, 'tâche échouée')).catch(() => undefined); // déjà remboursé : sans effet
}

export async function history(db: Db, userId: string, limit = 30) {
  return db.query(`SELECT delta,balance_after,reason,note,created_at FROM token_ledger WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, limit]);
}

/** Ajustement manuel par l'administrateur (toujours journalisé avec un motif). */
export async function adminAdjust(db: Db, userId: string, delta: number, reason: string) {
  if (!reason || reason.length < 3) throw bad('reason_required', 'Un motif est obligatoire');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw bad('invalid_amount', 'Quantité invalide');
  if (!(await db.get(`SELECT id FROM users WHERE id=$1`, [userId]))) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
  return db.tx((t) => credit(t, userId, delta, delta > 0 ? 'admin_grant' : 'admin_adjust', null, reason.slice(0, 200)));
}
