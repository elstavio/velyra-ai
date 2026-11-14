import { config } from '../config.js';
import { hmacSha256, safeEqual } from '../lib/crypto.js';
import type { InitParams, PaymentProvider, PayoutCheckResult, PayoutProvider, PayoutRequest, PayoutSendResult, VerifyResult } from './types.js';

// Sources : documentation CinetPay (docs.cinetpay.com) — Initialisation (v2/payment), Vérification (v2/payment/check),
// Notification (x-token HMAC) et API de transfert (client.cinetpay.com/v1).

async function postJson(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`CinetPay: réponse non JSON (HTTP ${r.status})`); }
}

/** CinetPay refuse certains caractères dans la description (#, /, $, _, &). */
export const cleanDescription = (s: string) => s.replace(/[#/$_&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

export class CinetPayPayments implements PaymentProvider {
  readonly name = 'cinetpay' as const;
  async init(p: InitParams) {
    const c = config.cinetpay;
    if (p.currency !== 'USD' && p.amount % 5 !== 0) throw new Error('CinetPay exige un montant multiple de 5 (hors USD)');
    const body: Record<string, unknown> = {
      apikey: c.apiKey, site_id: c.siteId, transaction_id: p.ref, amount: p.amount, currency: p.currency,
      description: cleanDescription(p.description), notify_url: p.notifyUrl, return_url: p.returnUrl, channels: p.channels, lang: 'fr',
    };
    if (p.customer) {
      Object.assign(body, {
        customer_name: p.customer.name, customer_surname: p.customer.surname, customer_email: p.customer.email, customer_phone_number: p.customer.phone,
        customer_address: p.customer.address, customer_city: p.customer.city, customer_country: p.customer.country, customer_zip_code: p.customer.zip,
      });
    }
    const j = await postJson(`${c.checkoutBase}/payment`, body);
    if (String(j.code) !== '201' || !j.data?.payment_url) throw new Error(`CinetPay init refusée : ${j.message ?? 'erreur'} (${j.code ?? '?'})`);
    return { paymentUrl: String(j.data.payment_url), token: j.data.payment_token ? String(j.data.payment_token) : undefined };
  }
  async verify(ref: string): Promise<VerifyResult> {
    const c = config.cinetpay;
    const j = await postJson(`${c.checkoutBase}/payment/check`, { apikey: c.apiKey, site_id: c.siteId, transaction_id: ref });
    const d = j.data ?? {};
    const amount = d.amount !== undefined ? Number(d.amount) : undefined;
    if (String(j.code) === '00' && d.status === 'ACCEPTED') return { status: 'ACCEPTED', amount, currency: d.currency, method: d.payment_method, raw: j };
    if (d.status === 'REFUSED' || String(j.code) === '627') return { status: 'REFUSED', raw: j };
    return { status: 'PENDING', raw: j }; // WAITING_FOR_CUSTOMER ou statut inconnu : jamais considéré comme un échec définitif
  }
}

/** Jeton x-token : HMAC-SHA256 de la concaténation des champs de la notification, dans l'ordre de la documentation. */
export function cinetpayToken(b: Record<string, string | undefined>, secret: string): string {
  const f = ['cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature', 'payment_method', 'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config', 'cpm_page_action', 'cpm_custom', 'cpm_designation', 'cpm_error_message'];
  return hmacSha256(secret, f.map((k) => b[k] ?? '').join(''));
}
export const cinetpayTokenValid = (b: Record<string, string | undefined>, header: string | undefined, secret: string) =>
  !!header && !!secret && safeEqual(header.toLowerCase(), cinetpayToken(b, secret).toLowerCase());

export class CinetPayPayouts implements PayoutProvider {
  readonly name = 'cinetpay' as const;
  private token: { v: string; at: number } | null = null;
  private async login(): Promise<string> {
    if (this.token && Date.now() - this.token.at < 20 * 60_000) return this.token.v;
    const c = config.cinetpay;
    const r = await fetch(`${c.transferBase}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apikey: c.apiKey, password: c.transferPassword }), signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json();
    if (Number(j.code) !== 0 || !j.data?.token) throw new Error(`CinetPay login transfert refusé : ${j.message ?? j.code}`);
    this.token = { v: j.data.token, at: Date.now() };
    return this.token.v;
  }
  private async form(path: string, data: unknown): Promise<any> {
    const token = await this.login();
    const r = await fetch(`${config.cinetpay.transferBase}${path}?token=${encodeURIComponent(token)}&lang=fr`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: JSON.stringify(data) }), signal: AbortSignal.timeout(20_000),
    });
    return r.json();
  }
  async send(q: PayoutRequest): Promise<PayoutSendResult> {
    try {
      // Étape 1 : le numéro doit figurer dans les contacts CinetPay (réponse « succès » même s'il existe déjà).
      const contact = await this.form('/transfer/contact', [{ prefix: q.prefix, phone: q.phone, name: 'Proprietaire', surname: 'Velyra', email: config.ownerNotifyEmail || 'owner@example.com' }]);
      if (Number(contact.code) !== 0) return { ok: false, error: `contact: ${contact.message ?? contact.code}`, raw: contact };
      // Étape 2 : envoi. Le préfixe est sans « + ». Montant : multiple de 5.
      const item: Record<string, unknown> = { prefix: q.prefix, phone: q.phone, amount: q.amount - (q.amount % 5), client_transaction_id: q.ref, notify_url: q.notifyUrl };
      if (q.walletHint) item.payment_method = q.walletHint;
      const j = await this.form('/transfer/money/send/contact', [item]);
      if (Number(j.code) !== 0) return { ok: false, error: `${j.message ?? 'refus'} (${j.code})`, raw: j };
      const e = Array.isArray(j.data) ? j.data[0] : undefined;
      return { ok: true, providerRef: e?.transaction_id ? String(e.transaction_id) : undefined, raw: j };
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  }
  async check(ref: string): Promise<PayoutCheckResult> {
    try {
      const token = await this.login();
      const r = await fetch(`${config.cinetpay.transferBase}/transfer/check/money?token=${encodeURIComponent(token)}&lang=fr&client_transaction_id=${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json();
      const e = Array.isArray(j.data) ? j.data[0] : undefined;
      if (!e) return { state: 'pending', detail: `réponse sans données (${j.code})`, raw: j };
      const t = String(e.treatment_status ?? '').toUpperCase();
      // La doc cite « NEW » et « VAL » et décrit : nouveau, en cours, validé, rejeté. Valeurs de rejet exactes non documentées -> motifs usuels.
      if (t === 'VAL') return { state: 'confirmed', raw: j };
      if (/^(REJ|CAN|ERR|FAIL|REF)/.test(t)) return { state: 'failed', detail: String(e.comment ?? t), raw: j };
      return { state: 'pending', detail: t, raw: j };
    } catch (e: any) { return { state: 'pending', detail: String(e?.message ?? e) }; }
  }
}
