import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { bad, nowIso, uid, HttpError, str } from '../lib/util.js';
import { PHONE_PREFIX } from '../data/regions.js';
import type { PayoutProvider } from '../providers/types.js';
import { notifyEmail, notifyOwner } from './notify.js';
import { logEvent } from './security.js';
import { postLedger } from './wallet.js';

// ---------------------------------------------------------------- configuration du compte propriétaire (§5.2)
export const CHANNELS = ['wave', 'mtn', 'orange', 'moov'] as const;
const WAVE_HINT: Record<string, string> = { CI: 'WAVECI', SN: 'WAVESN' }; // seuls portefeuilles cités dans la doc de transfert CinetPay

export async function saveAccount(db: Db, b: { channel: unknown; country: unknown; phone: unknown; primary?: unknown; id?: unknown }) {
  const channel = String(b.channel ?? '');
  if (!(CHANNELS as readonly string[]).includes(channel)) throw bad('invalid_channel', 'Canal inconnu (wave, mtn, orange, moov)');
  const country = str(b.country, 'pays', { max: 3 }).toUpperCase();
  const prefix = PHONE_PREFIX[country];
  if (!prefix) throw bad('invalid_country', 'Pays non pris en charge pour les transferts');
  const phone = String(b.phone ?? '').replace(/[\s.\-()+]/g, '').replace(new RegExp(`^${prefix}`), '');
  if (!/^\d{8,12}$/.test(phone)) throw bad('invalid_phone', 'Numéro invalide (sans indicatif pays)');
  const id = b.id ? String(b.id) : uid(), now = nowIso();
  const enc = encrypt(phone); // chiffré au repos, utilisé uniquement pour les transferts
  const exists = await db.get(`SELECT id FROM payout_accounts WHERE id=$1`, [id]);
  const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payout_accounts`);
  const primary = b.primary === true || (count?.n ?? 0) === 0 ? 1 : 0;
  await db.tx(async (t) => {
    if (primary) await t.run(`UPDATE payout_accounts SET is_primary=0`);
    if (exists) await t.run(`UPDATE payout_accounts SET channel=$2,country=$3,prefix=$4,phone_enc=$5,phone_last4=$6,is_primary=CASE WHEN $7=1 THEN 1 ELSE is_primary END,updated_at=$8 WHERE id=$1`, [id, channel, country, prefix, enc, phone.slice(-4), primary, now]);
    else await t.run(`INSERT INTO payout_accounts (id,channel,country,prefix,phone_enc,phone_last4,is_primary,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, channel, country, prefix, enc, phone.slice(-4), primary, now]);
  });
  return id;
}
export async function listAccounts(db: Db) {
  const rows = await db.query<any>(`SELECT id,channel,country,prefix,phone_last4,is_primary FROM payout_accounts ORDER BY is_primary DESC, created_at`);
  return rows.map((r) => ({ id: r.id, channel: r.channel, country: r.country, masked: `+${r.prefix} •••• ${r.phone_last4}`, primary: !!r.is_primary }));
}
export async function setPrimary(db: Db, id: string) {
  const r = await db.tx(async (t) => { await t.run(`UPDATE payout_accounts SET is_primary=0`); return t.run(`UPDATE payout_accounts SET is_primary=1 WHERE id=$1`, [id]); });
  if (!r.changes) throw new HttpError(404, 'not_found', 'Compte introuvable');
}
export async function deleteAccount(db: Db, id: string) { await db.run(`DELETE FROM payout_accounts WHERE id=$1`, [id]); }

// ---------------------------------------------------------------- traitement (§5.3)
const backoffMinutes = (attempts: number) => Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// ---------------------------------------------------------------- confirmation obligatoire par email (§8 — sécurité des retraits)
// Aucun retrait n'est exécuté — qu'il soit déclenché automatiquement après un paiement, ou manuellement
// depuis le tableau de bord admin (relance d'un transfert retenu/en échec) — sans qu'un lien envoyé par
// email au propriétaire ait été cliqué. Tant que ce n'est pas le cas, le transfert reste « pending » et
// aucun fonds ne quitte le wallet.
async function ensureConfirmation(db: Db, p: { id: string; amount: number; currency: string }): Promise<{ status: string }> {
  const now = nowIso();
  const existing = await db.get<any>(`SELECT * FROM payout_confirmations WHERE payout_id=$1`, [p.id]);
  if (existing?.status === 'confirmed') return { status: 'confirmed' };
  if (existing && existing.expires_at > now) return { status: 'pending' }; // lien déjà envoyé, encore valable
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.payoutConfirmTtlHours * 3_600_000).toISOString();
  if (existing) {
    await db.run(`UPDATE payout_confirmations SET token_hash=$2, status='pending', created_at=$3, expires_at=$4, confirmed_at=NULL, confirmed_ip=NULL, sent_count=sent_count+1 WHERE payout_id=$1`, [p.id, sha256(token), now, expires]);
  } else {
    await db.run(`INSERT INTO payout_confirmations (id,payout_id,token_hash,status,created_at,expires_at,sent_count) VALUES ($1,$2,$3,'pending',$4,$5,1)`, [uid(), p.id, sha256(token), now, expires]);
  }
  const link = `${config.appUrl}/api/payouts/confirm/${token}`;
  await notifyOwner(
    db,
    'Confirmation requise pour un retrait',
    `Un retrait de ${p.amount} ${p.currency} attend votre confirmation avant d'être exécuté.\n\nCliquez sur ce lien pour l'autoriser (valable ${config.payoutConfirmTtlHours} h) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette opération, ne cliquez pas sur ce lien et vérifiez votre compte depuis le tableau de bord admin.`,
    { sms: true },
  );
  await logEvent(db, 'payout_confirmation_requested', 'medium', { detail: { payout: p.id, amount: p.amount, currency: p.currency } });
  return { status: 'pending' };
}

/** Appelée par la route publique /api/payouts/confirm/:token (lien reçu par email). */
export async function confirmPayout(db: Db, token: string, ip: string): Promise<{ ok: boolean; message: string }> {
  const row = await db.get<any>(`SELECT * FROM payout_confirmations WHERE token_hash=$1`, [sha256(token)]);
  if (!row) return { ok: false, message: 'Lien invalide ou inconnu.' };
  if (row.status === 'confirmed') return { ok: true, message: 'Ce retrait a déjà été confirmé précédemment.' };
  if (row.expires_at < nowIso()) return { ok: false, message: 'Ce lien a expiré. Un nouveau lien de confirmation sera envoyé automatiquement par email lors de la prochaine tentative de transfert.' };
  await db.run(`UPDATE payout_confirmations SET status='confirmed', confirmed_at=$2, confirmed_ip=$3 WHERE id=$1`, [row.id, nowIso(), ip]);
  await logEvent(db, 'payout_confirmed', 'medium', { ip, detail: { payout: row.payout_id } });
  return { ok: true, message: 'Retrait confirmé. Le transfert sera exécuté lors du prochain passage automatique (quelques minutes).' };
}

/** Réservé aux tests : simule le clic sur le lien de confirmation envoyé par email, sans dépendre du réseau. */
export async function _confirmForTests(db: Db, payoutId: string) {
  const now = nowIso(), expires = new Date(Date.now() + 3_600_000).toISOString();
  const existing = await db.get<any>(`SELECT id FROM payout_confirmations WHERE payout_id=$1`, [payoutId]);
  if (existing) await db.run(`UPDATE payout_confirmations SET status='confirmed', confirmed_at=$2, confirmed_ip='test' WHERE payout_id=$1`, [payoutId, now]);
  else await db.run(`INSERT INTO payout_confirmations (id,payout_id,token_hash,status,created_at,expires_at,confirmed_at,confirmed_ip,sent_count) VALUES ($1,$2,'test','confirmed',$3,$4,$3,'test',1)`, [uid(), payoutId, now, expires]);
}

export async function processPayouts(db: Db, provider: PayoutProvider): Promise<{ sent: number; failed: number; confirmed: number }> {
  const out = { sent: 0, failed: 0, confirmed: 0 };
  const due = await db.query<any>(`SELECT * FROM payouts WHERE status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= $1) AND attempts < $2 ORDER BY created_at LIMIT 20`, [nowIso(), config.payoutMaxAttempts]);
  for (const p of due) {
    // Confirmation obligatoire par email avant toute exécution réelle du transfert.
    const conf = await ensureConfirmation(db, p);
    if (conf.status !== 'confirmed') continue;
    // Réservation atomique : une seule instance/boucle traite un transfert donné.
    const claim = await db.run(`UPDATE payouts SET status='sending', updated_at=$2 WHERE id=$1 AND status IN ('pending','failed')`, [p.id, nowIso()]);
    if (!claim.changes) continue;
    const acc = await db.get<any>(`SELECT * FROM payout_accounts WHERE is_primary=1`) ?? await db.get<any>(`SELECT * FROM payout_accounts ORDER BY created_at LIMIT 1`);
    if (!acc) {
      await db.run(`UPDATE payouts SET status='pending', last_error=$2, next_attempt_at=$3, updated_at=$4 WHERE id=$1`, [p.id, 'Aucun compte de réception configuré : les fonds restent dans le wallet', inMinutes(30), nowIso()]);
      if (p.last_error == null) await notifyOwner(db, 'Compte de réception manquant', 'Des fonds attendent un transfert. Renseignez votre numéro Wave/MTN/Moov dans le tableau de bord (Wallet & transferts). Les fonds sont conservés dans le wallet.');
      continue;
    }
    if (p.amount < config.payoutMinAmount) {
      await db.run(`UPDATE payouts SET status='held', last_error=$2, updated_at=$3 WHERE id=$1`, [p.id, `Montant inférieur au minimum de transfert (${config.payoutMinAmount})`, nowIso()]);
      continue;
    }
    const attempts = p.attempts + 1;
    const res = await provider.send({ ref: p.id, amount: p.amount, prefix: acc.prefix, phone: decrypt(acc.phone_enc), notifyUrl: `${config.appUrl}/api/webhooks/cinetpay-transfer`, walletHint: acc.channel === 'wave' ? WAVE_HINT[acc.country] : undefined });
    if (res.ok) {
      await db.tx(async (t) => {
        await t.run(`UPDATE payouts SET status='sent', attempts=$2, provider=$3, provider_ref=$4, channel=$5, account_id=$6, last_error=NULL, updated_at=$7 WHERE id=$1`, [p.id, attempts, provider.name, res.providerRef ?? null, acc.channel, acc.id, nowIso()]);
        await postLedger(t, { currency: p.currency, kind: `payout_debit:${attempts}`, amount: -p.amount, payoutId: p.id, note: 'transfert vers propriétaire' });
      });
      out.sent++;
    } else {
      const giveUp = attempts >= config.payoutMaxAttempts;
      await db.run(`UPDATE payouts SET status=$2, attempts=$3, last_error=$4, next_attempt_at=$5, updated_at=$6 WHERE id=$1`, [p.id, giveUp ? 'abandoned' : 'failed', attempts, (res.error ?? 'erreur').slice(0, 300), giveUp ? null : inMinutes(backoffMinutes(attempts)), nowIso()]);
      await logEvent(db, 'payout_failed', giveUp ? 'high' : 'low', { detail: { payout: p.id, attempts, error: res.error } });
      await notifyOwner(db, giveUp ? 'Transfert abandonné — intervention requise' : 'Échec de transfert (nouvelle tentative programmée)',
        `Transfert ${p.id} de ${p.amount} ${p.currency} : ${res.error}\nTentative ${attempts}/${config.payoutMaxAttempts}. Aucun fonds perdu : le montant reste dans le wallet.`);
      out.failed++;
    }
  }
  // Suivi des transferts envoyés : confirmation ou annulation (le wallet est recrédité en cas d'échec).
  const sent = await db.query<any>(`SELECT * FROM payouts WHERE status='sent'`);
  for (const p of sent) {
    const c = await provider.check(p.id);
    if (c.state === 'confirmed') { await db.run(`UPDATE payouts SET status='confirmed', updated_at=$2 WHERE id=$1 AND status='sent'`, [p.id, nowIso()]); out.confirmed++; }
    else if (c.state === 'failed') {
      await db.tx(async (t) => {
        const u = await t.run(`UPDATE payouts SET status='failed', last_error=$2, next_attempt_at=$3, updated_at=$4 WHERE id=$1 AND status='sent'`, [p.id, `rejeté par l'opérateur : ${c.detail ?? ''}`.slice(0, 300), inMinutes(10), nowIso()]);
        if (u.changes) await postLedger(t, { currency: p.currency, kind: `payout_reversal:${p.attempts}`, amount: p.amount, payoutId: p.id, note: 'transfert rejeté, fonds restitués au wallet' });
      });
      await notifyOwner(db, 'Transfert rejeté', `Transfert ${p.id} rejeté : ${c.detail ?? ''}. Les fonds sont revenus dans le wallet ; nouvelle tentative programmée.`);
    } else if (Date.now() - Date.parse(p.updated_at) > 48 * 3_600_000 && !p.last_error?.startsWith('non confirmé')) {
      await db.run(`UPDATE payouts SET last_error='non confirmé après 48 h' WHERE id=$1`, [p.id]);
      await notifyOwner(db, 'Transfert non confirmé', `Le transfert ${p.id} n'est pas confirmé depuis 48 h. Vérifiez la validation par email chez CinetPay (confirmation requise sauf IP autorisée).`);
    }
  }
  // Auto-réparation : un « sending » interrompu (crash) pourrait déjà avoir été envoyé -> revue manuelle, jamais de renvoi automatique (évite le double paiement).
  const stuck = await db.query<{ id: string }>(`SELECT id FROM payouts WHERE status='sending' AND updated_at < $1`, [inMinutes(-10)]);
  for (const s of stuck) {
    await db.run(`UPDATE payouts SET status='review', last_error='Interrompu pendant l''envoi : vérifier chez l''agrégateur avant de relancer', updated_at=$2 WHERE id=$1 AND status='sending'`, [s.id, nowIso()]);
    await notifyOwner(db, 'Transfert à vérifier manuellement', `Le transfert ${s.id} a été interrompu pendant l'envoi. Vérifiez chez l'agrégateur puis relancez ou marquez-le depuis le tableau de bord.`);
  }
  return out;
}

/** Actions administrateur sur un transfert retenu / à revoir. */
export async function releasePayout(db: Db, id: string, by: string) {
  const r = await db.run(`UPDATE payouts SET status='pending', attempts=0, next_attempt_at=$2, last_error=NULL, updated_at=$2 WHERE id=$1 AND status IN ('held','review','abandoned','failed')`, [id, nowIso()]);
  if (!r.changes) throw new HttpError(409, 'not_releasable', 'Ce transfert ne peut pas être relancé');
  await db.run(`INSERT INTO audit_log (id,actor_id,action,target,created_at) VALUES ($1,$2,'payout_release',$3,$4)`, [uid(), by, id, nowIso()]);
}
