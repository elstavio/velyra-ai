import type { Db } from '../db/index.js';
import { config } from '../config.js';
import type { InitParams, PaymentProvider, PayoutCheckResult, PayoutProvider, PayoutRequest, PayoutSendResult, VerifyResult } from './types.js';

/** Fournisseur de démonstration : aucune somme réelle. Interdit en production sauf ALLOW_MOCK_PROVIDERS=true. */
export class MockPayments implements PaymentProvider {
  readonly name = 'mock' as const;
  constructor(private db: Db) {}
  async init(p: InitParams) {
    await this.db.run(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [`mockpay:${p.ref}`, JSON.stringify({ status: 'PENDING', amount: p.amount, currency: p.currency })]);
    return { paymentUrl: `${config.appUrl}/mock-pay/${p.ref}`, token: 'mock' };
  }
  async verify(ref: string): Promise<VerifyResult> {
    const r = await this.db.get<{ value: string }>(`SELECT value FROM settings WHERE key=$1`, [`mockpay:${ref}`]);
    if (!r) return { status: 'REFUSED', raw: 'inconnu' };
    const s = JSON.parse(r.value);
    return { status: s.status, amount: s.amount, currency: s.currency, method: 'MOCK', raw: s };
  }
  async setState(ref: string, status: 'ACCEPTED' | 'REFUSED', overrideAmount?: number) {
    const r = await this.db.get<{ value: string }>(`SELECT value FROM settings WHERE key=$1`, [`mockpay:${ref}`]);
    if (!r) return false;
    const s = JSON.parse(r.value);
    if (overrideAmount !== undefined) s.amount = overrideAmount;
    await this.db.run(`UPDATE settings SET value=$2 WHERE key=$1`, [`mockpay:${ref}`, JSON.stringify({ ...s, status })]);
    return true;
  }
}

export class MockPayouts implements PayoutProvider {
  readonly name = 'mock' as const;
  /** Pour les tests : références forcées en échec. */
  static failNext = 0;
  static sent: PayoutRequest[] = [];
  async send(r: PayoutRequest): Promise<PayoutSendResult> {
    if (MockPayouts.failNext > 0) { MockPayouts.failNext--; return { ok: false, error: 'échec simulé' }; }
    MockPayouts.sent.push(r);
    return { ok: true, providerRef: `MOCK-${r.ref}` };
  }
  async check(): Promise<PayoutCheckResult> { return { state: 'confirmed' }; }
}
