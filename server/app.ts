import type { Db } from './db/index.js';
import type { PaymentProvider, PayoutProvider } from './providers/types.js';

export interface App {
  db: Db;
  payments: PaymentProvider;
  payouts: PayoutProvider;
  /** Stripe (SEPA, Apple Pay, Google Pay, cartes hors Afrique) : présent seulement si STRIPE_SECRET_KEY est défini. */
  stripe?: PaymentProvider;
}
