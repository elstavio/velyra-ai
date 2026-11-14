import type { Db } from '../db/index.js';
import { nowIso, uid } from '../lib/util.js';

/** kind : 'credit', 'payout_debit:<tentative>', 'payout_reversal:<tentative>' ou 'adjust'.
 * Écrit une ligne du grand livre et met à jour le solde. Doit être appelé dans une transaction. */
export async function postLedger(db: Db, e: { currency: string; kind: string; amount: number; paymentId?: string; payoutId?: string; note?: string }): Promise<number | null> {
  await db.run(`INSERT INTO wallets (currency,balance,updated_at) VALUES ($1,0,$2) ON CONFLICT (currency) DO NOTHING`, [e.currency, nowIso()]);
  // Les index uniques (payment_id, kind) et (payout_id, kind) interdisent toute double écriture.
  const dup = e.paymentId
    ? await db.get(`SELECT id FROM wallet_ledger WHERE payment_id=$1 AND kind=$2`, [e.paymentId, e.kind])
    : e.payoutId ? await db.get(`SELECT id FROM wallet_ledger WHERE payout_id=$1 AND kind=$2`, [e.payoutId, e.kind]) : undefined;
  if (dup) return null;
  const w = await db.get<{ balance: number }>(`UPDATE wallets SET balance = balance + $2, updated_at=$3 WHERE currency=$1 RETURNING balance`, [e.currency, e.amount, nowIso()]);
  await db.run(`INSERT INTO wallet_ledger (id,currency,kind,amount,balance_after,payment_id,payout_id,note,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uid(), e.currency, e.kind, e.amount, w!.balance, e.paymentId ?? null, e.payoutId ?? null, e.note ?? null, nowIso()]);
  return w!.balance;
}

export async function balances(db: Db) {
  return db.query<{ currency: string; balance: number }>(`SELECT currency, balance FROM wallets ORDER BY currency`);
}
