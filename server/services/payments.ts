import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { hit } from '../lib/ratelimit.js';
import { HttpError, addDays, bad, conflict, forbidden, nowIso, parseJson, str, uid } from '../lib/util.js';
import { COUNTRIES, MOBILE_METHODS, STRIPE_ONLY_METHODS, currencyOf, methodsFor, type Method } from '../data/regions.js';
import type { PaymentProvider, VerifyResult } from '../providers/types.js';
import type { UserRow } from './auth.js';
import { notifyEmail, notifyOwner } from './notify.js';
import { logEvent } from './security.js';
import { postLedger } from './wallet.js';
import * as tokens from './tokens.js';

export const TOKEN_PACKS: { code: string; tokens: number; xof: number; eur: number }[] = [
  { code: 'tokens_100', tokens: 100, xof: 2500, eur: 4 }, { code: 'tokens_500', tokens: 500, xof: 8000, eur: 12 },
  { code: 'tokens_1000', tokens: 1000, xof: 12000, eur: 18 }, { code: 'tokens_5000', tokens: 5000, xof: 20000, eur: 30 },
];
/** Paquets de jetons : XOF/XAF fixés par vous ; EUR = exemple ; CDF, GNF, USD à définir dans Admin › Offres et prix (je n'ai pas de taux fiable). */
async function ensureTokenPacks(db: Db) {
  for (const k of TOKEN_PACKS) {
    if (await db.get(`SELECT code FROM plans WHERE code=$1`, [k.code])) continue;
    await db.run(`INSERT INTO plans (code,name,description,duration_days,features,active) VALUES ($1,$2,$3,0,$4,1)`, [k.code, `${k.tokens} jetons`, `${k.tokens} jetons IA (1 jeton = 1 tâche). Sans date d'expiration.`, JSON.stringify([`tokens:${k.tokens}`])]);
    for (const [cur, amt] of [['XOF', k.xof], ['XAF', k.xof], ['EUR', k.eur]] as const) await db.run(`INSERT INTO plan_prices (plan_code,currency,amount) VALUES ($1,$2,$3)`, [k.code, cur, amt]);
  }
}
export const packTokens = (features: unknown): number => { const f = parseJson<string[]>(typeof features === 'string' ? features : JSON.stringify(features ?? []), []).find((x) => x.startsWith('tokens:')); return f ? Number(f.slice(7)) || 0 : 0; };

export async function seedPlans(db: Db) {
  const have = await db.get(`SELECT code FROM plans LIMIT 1`);
  // Prix en euros (Stripe, Europe) : exemples, ajoutés s'ils n'existent pas encore sans écraser vos réglages.
  const ensureEur = async () => { for (const [code, amt] of [['pro', 8], ['tiktok_pro', 4], ['social_pro', 14]] as const) await db.run(`INSERT INTO plan_prices (plan_code,currency,amount) VALUES ($1,'EUR',$2) ON CONFLICT (plan_code,currency) DO NOTHING`, [code, amt]); };
  // Offre « Social » : ajoutée aux bases existantes sans écraser vos réglages (prix d'EXEMPLE, à ajuster dans Admin › Offres et prix).
  const ensureSocial = async () => {
    if (await db.get(`SELECT code FROM plans WHERE code='social_pro'`)) return;
    await db.run(`INSERT INTO plans (code,name,description,duration_days,features,active) VALUES ('social_pro','Velyra Social','Tout Velyra Pro + connexion de vos comptes TikTok, YouTube, Facebook, Instagram et WhatsApp + agent Créateur de contenu alimenté par vos vrais chiffres (30 jours).',30,$1,1)`, [JSON.stringify(['platform', 'social'])]);
    for (const [cur, amt] of Object.entries({ XOF: 9000, XAF: 9000, CDF: 27000, GNF: 144000, USD: 15 })) await db.run(`INSERT INTO plan_prices (plan_code,currency,amount) VALUES ('social_pro',$1,$2)`, [cur, amt]);
  };
  await ensureTokenPacks(db);
  if (have) { await ensureSocial(); await ensureEur(); return; }
  // Prix d'EXEMPLE : à ajuster par le propriétaire dans le tableau de bord (Offres). Montants XOF/XAF/CDF/GNF multiples de 5.
  const plans = [
    { code: 'pro', name: 'Velyra Pro', description: 'Accès complet à la plateforme pendant 30 jours.', days: 30, features: ['platform'], prices: { XOF: 5000, XAF: 5000, CDF: 15000, GNF: 80000, USD: 9 } },
    { code: 'tiktok_pro', name: 'Option TikTok avancée', description: 'Recommandations approfondies et suivi détaillé TikTok (30 jours). Nécessite un accès à la plateforme.', days: 30, features: ['tiktok_advanced'], prices: { XOF: 3000, XAF: 3000, CDF: 9000, GNF: 48000, USD: 5 } },
  ];
  for (const p of plans) {
    await db.run(`INSERT INTO plans (code,name,description,duration_days,features,active) VALUES ($1,$2,$3,$4,$5,1)`, [p.code, p.name, p.description, p.days, JSON.stringify(p.features)]);
    for (const [cur, amt] of Object.entries(p.prices)) await db.run(`INSERT INTO plan_prices (plan_code,currency,amount) VALUES ($1,$2,$3)`, [p.code, cur, amt]);
  }
  await ensureSocial();
  await ensureEur();
}

export async function listPlans(db: Db, country: string | null) {
  const c = country ? COUNTRIES[country] : undefined;
  const plans = await db.query<any>(`SELECT * FROM plans WHERE active=1 ORDER BY code`);
  const out = [];
  for (const p of plans) {
    const prices = await db.query<{ currency: string; amount: number }>(`SELECT currency, amount FROM plan_prices WHERE plan_code=$1`, [p.code]);
    out.push({
      code: p.code, name: p.name, description: p.description, durationDays: p.duration_days, features: parseJson<string[]>(p.features, []),
      price: c ? prices.find((x) => x.currency === currencyOf(c)) ?? null : null, prices,
    });
  }
  return { country: country ?? null, region: c?.region ?? null, currency: c ? currencyOf(c) : null, methods: c ? methodsFor(c.region) : [], plans: out };
}

const newRef = () => `VLY${Date.now().toString(36).toUpperCase()}${uid().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

export interface CheckoutInput { planCode: unknown; country: unknown; method: unknown; billing?: Record<string, unknown> }

export async function createCheckout(db: Db, primary: PaymentProvider, user: UserRow, b: CheckoutInput, stripe?: PaymentProvider) {
  if (!user.email_verified) throw forbidden('Vérifiez votre adresse email avant de payer', 'email_unverified');
  if (user.status !== 'active') throw forbidden('Compte suspendu', 'account_disabled');
  if (user.extra_verification && !user.phone_verified) throw forbidden('Vérification supplémentaire requise : confirmez votre numéro par SMS', 'extra_verification_required');
  const rl = hit(`checkout:${user.id}`, 10, 3_600_000);
  if (!rl.allowed) throw new HttpError(429, 'rate_limited', 'Trop de tentatives de paiement. Réessayez plus tard.');

  const country = str(b.country, 'pays', { max: 8 }).toUpperCase();
  const c = COUNTRIES[country];
  if (!c) throw bad('invalid_country', 'Pays inconnu');
  const method = str(b.method, 'moyen de paiement', { max: 20 }) as Method;
  const allowed = methodsFor(c.region).find((m) => m.id === method);
  if (!allowed) throw bad('method_not_offered', 'Ce moyen de paiement n\'est pas proposé dans votre région');
  if (!allowed.available) throw bad('method_unavailable', allowed.note ?? 'Moyen de paiement indisponible');

  // Choix de l'agrégateur : SEPA / Apple Pay / Google Pay → Stripe ; Europe et « autres pays » par carte → Stripe s'il est configuré ; sinon CinetPay (ou démonstration).
  const provider = stripe && (STRIPE_ONLY_METHODS.includes(method) || (method === 'card' && (c.region === 'europe' || c.region === 'other'))) ? stripe : primary;
  const currency = currencyOf(c);
  const plan = await db.get<{ code: string; name: string; duration_days: number; features: string }>(`SELECT code,name,duration_days,features FROM plans WHERE code=$1 AND active=1`, [String(b.planCode ?? '')]);
  if (!plan) throw bad('invalid_plan', 'Offre inconnue');
  const price = await db.get<{ amount: number }>(`SELECT amount FROM plan_prices WHERE plan_code=$1 AND currency=$2`, [plan.code, currency]);
  if (!price) throw bad('no_price', `Aucun prix défini en ${currency} pour cette offre`);

  const isMobile = MOBILE_METHODS.includes(method);
  let customer;
  if (!isMobile && provider.name !== 'stripe') {
    const bl = b.billing ?? {};
    customer = {
      name: str(bl.firstName, 'prénom', { max: 60 }), surname: str(bl.lastName, 'nom', { max: 60 }), email: user.email,
      phone: str(bl.phone ?? user.phone, 'téléphone', { max: 20 }), address: str(bl.address, 'adresse', { max: 120 }),
      city: str(bl.city, 'ville', { max: 60 }), country, zip: str(bl.zip, 'code postal', { max: 10 }).slice(0, 5),
    };
  }

  await db.run(`UPDATE users SET country=$2, updated_at=$3 WHERE id=$1`, [user.id, country, nowIso()]);
  const id = uid(), ref = newRef(), now = nowIso();
  // On enregistre le paiement AVANT d'appeler l'agrégateur (recommandation de la documentation).
  await db.run(`INSERT INTO payments (id,user_id,plan_code,amount,currency,country,region,provider,channel,provider_ref,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$11)`, [id, user.id, plan.code, price.amount, currency, country, c.region, provider.name, method, ref, now]);
  try {
    const r = await provider.init({
      method, customerEmail: user.email, cancelUrl: `${config.appUrl}/#/offres`,
      ref, amount: price.amount, currency, description: packTokens(plan.features) ? plan.name : `${plan.name} ${plan.duration_days} jours`,
      channels: isMobile ? 'ALL' : 'CREDIT_CARD', notifyUrl: `${config.appUrl}/api/webhooks/${provider.name === 'stripe' ? 'stripe' : 'cinetpay'}`,
      returnUrl: `${config.appUrl}/payment/return?ref=${ref}`, customer,
    });
    await db.run(`UPDATE payments SET payment_url=$2, provider_token=$3 WHERE id=$1`, [id, r.paymentUrl, r.token ?? null]);
    return { ref, paymentUrl: r.paymentUrl, amount: price.amount, currency, provider: provider.name };
  } catch (e: any) {
    await db.run(`UPDATE payments SET status='failed', updated_at=$2, raw=$3 WHERE id=$1`, [id, nowIso(), String(e?.message ?? e).slice(0, 500)]);
    throw new HttpError(502, 'provider_error', 'Le service de paiement est momentanément indisponible. Réessayez dans quelques minutes.');
  }
}

export async function paymentStatus(db: Db, userId: string, ref: string) {
  const p = await db.get<any>(`SELECT provider_ref, status, amount, currency, plan_code, confirmed_at FROM payments WHERE provider_ref=$1 AND user_id=$2`, [ref, userId]);
  if (!p) throw new HttpError(404, 'not_found', 'Paiement introuvable');
  return { ref: p.provider_ref, status: p.status, amount: p.amount, currency: p.currency, planCode: p.plan_code, confirmedAt: p.confirmed_at };
}

// ------------------------------------------------------------------------------------ règlement
interface PaymentRow { id: string; user_id: string | null; plan_code: string; amount: number; currency: string; status: string; provider: string; provider_ref: string; channel: string; country: string }

async function assessFraud(db: Db, p: PaymentRow, user: { status: string } | undefined): Promise<string[]> {
  const reasons: string[] = [];
  if (user && user.status !== 'active') reasons.push('compte_non_actif');
  if (p.user_id) {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const n = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payments WHERE user_id=$1 AND created_at >= $2`, [p.user_id, since]);
    if ((n?.n ?? 0) >= 5) reasons.push('vitesse_paiements_anormale');
    const open = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM fraud_reports WHERE user_id=$1 AND status='open'`, [p.user_id]);
    if ((open?.n ?? 0) > 0) reasons.push('signalement_fraude_ouvert');
  }
  return reasons;
}

export type SettleOutcome = 'activated' | 'already_processed' | 'refused' | 'pending' | 'invalid_amount' | 'unknown';

/**
 * Cœur du système (§4, §5) : à partir de la vérification serveur-à-serveur auprès de l'agrégateur,
 * règle le paiement UNE seule fois (transition atomique pending -> succeeded), crédite le wallet,
 * active l'abonnement et crée l'ordre de transfert. Idempotent : peut être appelé plusieurs fois.
 */
export async function settlePayment(db: Db, ref: string, v: VerifyResult): Promise<SettleOutcome> {
  const p = await db.get<PaymentRow>(`SELECT id,user_id,plan_code,amount,currency,status,provider,provider_ref,channel,country FROM payments WHERE provider_ref=$1`, [ref]);
  if (!p) return 'unknown';
  if (p.status !== 'pending') return 'already_processed';
  if (v.status === 'PENDING') return 'pending';
  if (v.status === 'REFUSED') {
    await db.run(`UPDATE payments SET status='failed', updated_at=$2, raw=$3 WHERE id=$1 AND status='pending'`, [p.id, nowIso(), JSON.stringify(v.raw).slice(0, 2000)]);
    return 'refused';
  }
  // ACCEPTED : le montant et la devise confirmés par l'agrégateur doivent correspondre à ce que nous avons demandé.
  if ((v.amount !== undefined && v.amount !== p.amount) || (v.currency && v.currency !== p.currency)) {
    await db.run(`UPDATE payments SET status='failed', fraud_flag=1, fraud_reasons=$3, updated_at=$2, raw=$4 WHERE id=$1 AND status='pending'`,
      [p.id, nowIso(), JSON.stringify(['montant_ou_devise_incoherent']), JSON.stringify(v.raw).slice(0, 2000)]);
    await logEvent(db, 'payment_amount_mismatch', 'high', { userId: p.user_id, detail: { ref, expected: `${p.amount} ${p.currency}`, got: `${v.amount} ${v.currency}` } });
    return 'invalid_amount';
  }
  const user = p.user_id ? await db.get<{ status: string; email: string }>(`SELECT status, email FROM users WHERE id=$1`, [p.user_id]) : undefined;
  const reasons = await assessFraud(db, p, user);
  const plan = await db.get<{ name: string; duration_days: number; features: string }>(`SELECT name, duration_days, features FROM plans WHERE code=$1`, [p.plan_code]);
  const packN = plan ? packTokens(plan.features) : 0;

  const won = await db.tx(async (t) => {
    const claim = await t.run(`UPDATE payments SET status='succeeded', confirmed_at=$2, updated_at=$2, fraud_flag=$3, fraud_reasons=$4, raw=$5 WHERE id=$1 AND status='pending'`,
      [p.id, nowIso(), reasons.length ? 1 : 0, reasons.length ? JSON.stringify(reasons) : null, JSON.stringify(v.raw).slice(0, 2000)]);
    if (!claim.changes) return false; // une autre notification l'a déjà réglé
    await postLedger(t, { currency: p.currency, kind: 'credit', amount: p.amount, paymentId: p.id, note: `paiement ${p.provider_ref}` });
    if (p.user_id && packN) await tokens.credit(t, p.user_id, packN, 'purchase', p.id, `paquet ${plan!.name}`);
    else if (p.user_id && plan) {
      const last = await t.get<{ e: string | null }>(`SELECT MAX(ends_at) AS e FROM subscriptions WHERE user_id=$1 AND plan_code=$2`, [p.user_id, p.plan_code]);
      const start = last?.e && last.e > nowIso() ? last.e : nowIso();
      await t.run(`INSERT INTO subscriptions (id,user_id,plan_code,payment_id,starts_at,ends_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uid(), p.user_id, p.plan_code, p.id, start, addDays(plan.duration_days, Date.parse(start)), nowIso()]);
    }
    const pid = uid();
    await t.run(`INSERT INTO payouts (id,payment_id,currency,amount,status,attempts,next_attempt_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,0,$6,$6,$6)`,
      [pid, p.id, p.currency, p.amount, reasons.length ? 'held' : 'pending', nowIso()]);
    if (reasons.length) await t.run(`INSERT INTO fraud_reports (id,user_id,source,reason,created_at) VALUES ($1,$2,'auto',$3,$4)`, [uid(), p.user_id ?? '', `Paiement ${p.provider_ref} retenu : ${reasons.join(', ')}`, nowIso()]);
    return true;
  });
  if (!won) return 'already_processed';

  if (reasons.length) await logEvent(db, 'payment_flagged', 'medium', { userId: p.user_id, detail: { ref, reasons } });
  if (user) await notifyEmail(db, user.email, 'Paiement confirmé — Velyra AI', `Votre paiement de ${p.amount} ${p.currency} (${plan?.name ?? p.plan_code}) est confirmé. Référence : ${p.provider_ref}.\n${packN ? `${packN} jetons ont été ajoutés à votre solde (sans date d'expiration).` : 'Votre accès est activé.'}`);
  await notifyOwner(db, `Paiement reçu : ${p.amount} ${p.currency}`, `Référence ${p.provider_ref} — offre ${p.plan_code}${reasons.length ? `\nATTENTION : transfert retenu (${reasons.join(', ')})` : ''}`);
  return 'activated';
}

/** Point d'entrée des notifications d'agrégateur : la notification n'est qu'un déclencheur ; le statut vient de la vérification. */
export async function processNotification(db: Db, provider: PaymentProvider, ref: string): Promise<SettleOutcome> {
  const p = await db.get<{ status: string }>(`SELECT status FROM payments WHERE provider_ref=$1`, [ref]);
  if (!p) return 'unknown';
  if (p.status !== 'pending') return 'already_processed';
  const v = await provider.verify(ref);
  return settlePayment(db, ref, v);
}

/** Résout l'agrégateur d'un paiement d'après la colonne `provider` enregistrée à la création. */
export type ProviderMap = Partial<Record<'cinetpay' | 'stripe' | 'mock', PaymentProvider>>;
export async function processNotificationAuto(db: Db, providers: ProviderMap, ref: string): Promise<SettleOutcome> {
  const p = await db.get<{ provider: string }>(`SELECT provider FROM payments WHERE provider_ref=$1`, [ref]);
  if (!p) return 'unknown';
  const prov = providers[p.provider as keyof ProviderMap];
  if (!prov) return 'pending'; // agrégateur non configuré sur ce serveur : on ne tranche pas
  return processNotification(db, prov, ref);
}

/** Rattrape les paiements restés « pending » (notification perdue). */
export async function reconcilePending(db: Db, provider: PaymentProvider): Promise<number> {
  const olderThan = new Date(Date.now() - 3 * 60_000).toISOString();
  const rows = await db.query<{ provider_ref: string; created_at: string }>(`SELECT provider_ref, created_at FROM payments WHERE status='pending' AND provider=$1 AND created_at < $2 ORDER BY created_at LIMIT 50`, [provider.name, olderThan]);
  let n = 0;
  for (const r of rows) {
    try {
      const out = await processNotification(db, provider, r.provider_ref);
      if (out === 'activated' || out === 'refused') n++;
      // Stripe : jamais d'abandon par délai (un prélèvement SEPA peut rester en cours plusieurs jours) ; la session expire côté Stripe → « refused ».
      else if (out === 'pending' && provider.name !== 'stripe' && Date.now() - Date.parse(r.created_at) > 48 * 3_600_000)
        await db.run(`UPDATE payments SET status='failed', updated_at=$2 WHERE provider_ref=$1 AND status='pending'`, [r.provider_ref, nowIso()]); // abandonné
    } catch { /* l'agrégateur peut être momentanément injoignable : prochaine passe */ }
  }
  return n;
}
export { conflict };
