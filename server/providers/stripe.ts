import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { hmacSha256, safeEqual } from '../lib/crypto.js';
import type { InitParams, PaymentProvider, VerifyResult } from './types.js';

// Sources : docs.stripe.com — « Create a Checkout Session » (POST /v1/checkout/sessions, corps form-urlencoded),
// « Receive Stripe events in your webhook endpoint » (en-tête Stripe-Signature : t=…,v1=… ; HMAC-SHA256 de « t.corps »),
// « Apple Pay » (le Checkout hébergé affiche Apple Pay sans configuration supplémentaire).
// Montants : Stripe attend la plus petite unité de la devise (centimes pour EUR/USD) ; nos prix sont en unités entières.

const ZERO_DECIMAL = new Set(['XOF', 'XAF', 'GNF', 'JPY', 'KRW']); // inutilisées avec Stripe ici, par prudence
export const toMinor = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? amount : amount * 100);
export const fromMinor = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? minor : minor / 100);

type Fetch = typeof fetch;

export class StripePayments implements PaymentProvider {
  readonly name = 'stripe' as const;
  constructor(private db: Db, private fetcher: Fetch = (...a) => fetch(...a)) {}

  private async call(path: string, init: RequestInit = {}) {
    const r = await this.fetcher(`${config.stripe.base}${path}`, {
      ...init, headers: { authorization: `Bearer ${config.stripe.secretKey}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe HTTP ${r.status}: ${String(j?.error?.message ?? '').slice(0, 200)}`);
    return j;
  }

  async init(p: InitParams) {
    const f = new URLSearchParams();
    f.set('mode', 'payment');
    f.set('client_reference_id', p.ref);
    f.set('success_url', p.returnUrl);
    f.set('cancel_url', p.cancelUrl ?? p.returnUrl);
    f.set('locale', 'fr');
    if (p.customerEmail) f.set('customer_email', p.customerEmail);
    f.set('line_items[0][quantity]', '1');
    f.set('line_items[0][price_data][currency]', p.currency.toLowerCase());
    f.set('line_items[0][price_data][unit_amount]', String(toMinor(p.amount, p.currency)));
    f.set('line_items[0][price_data][product_data][name]', p.description.slice(0, 120));
    f.set('metadata[ref]', p.ref);
    // SEPA : type de moyen explicite (EUR uniquement). Cartes, Apple Pay et Google Pay : « card » (les portefeuilles s'affichent automatiquement).
    f.append('payment_method_types[]', p.method === 'sepa' ? 'sepa_debit' : 'card');
    const j = await this.call('/v1/checkout/sessions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `velyra-${p.ref}` }, body: f.toString() });
    if (!j.id || !j.url) throw new Error('Stripe : session sans URL');
    return { paymentUrl: String(j.url), token: String(j.id) }; // le « token » est l'identifiant de session, nécessaire pour la vérification
  }

  async verify(ref: string): Promise<VerifyResult> {
    const row = await this.db.get<{ provider_token: string | null }>(`SELECT provider_token FROM payments WHERE provider_ref=$1`, [ref]);
    if (!row?.provider_token) return { status: 'REFUSED', raw: 'session inconnue' };
    const j = await this.call(`/v1/checkout/sessions/${encodeURIComponent(row.provider_token)}`);
    const cur = String(j.currency ?? '').toUpperCase();
    const base = { amount: typeof j.amount_total === 'number' ? fromMinor(j.amount_total, cur) : undefined, currency: cur || undefined, method: 'STRIPE', raw: { id: j.id, status: j.status, payment_status: j.payment_status } };
    if (j.payment_status === 'paid' || j.payment_status === 'no_payment_required') return { status: 'ACCEPTED', ...base };
    if (j.status === 'expired') return { status: 'REFUSED', ...base };
    return { status: 'PENDING', ...base }; // « unpaid » : en cours (le SEPA peut prendre plusieurs jours) ou abandonné
  }
}

/** Vérifie l'en-tête Stripe-Signature (schéma v1 uniquement, tolérance 5 min). */
export function stripeSignatureValid(raw: string, header: string, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  if (!secret || !header) return false;
  const parts = header.split(',').map((x) => x.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || !/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = hmacSha256(secret, `${t}.${raw}`);
  return sigs.some((s) => safeEqual(s, expected));
}
