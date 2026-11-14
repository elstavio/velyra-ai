import { assertProductionConfig, config } from './config.js';
import type { App } from './app.js';
import { openDb } from './db/index.js';
import { migrate } from './db/schema.js';
import { createHttpServer } from './server.js';
import { startJobs } from './jobs.js';
import { loadBlocks } from './services/security.js';
import { seedPlans } from './services/payments.js';
import { bootstrapAdmin } from './services/adminAuth.js';
import { CinetPayPayments, CinetPayPayouts } from './providers/cinetpay.js';
import { MockPayments, MockPayouts } from './providers/mock.js';
import { StripePayments } from './providers/stripe.js';
import { setBudgetGuard } from './services/llm.js';
import { createDbBudgetGuard } from './services/aibudget.js';

export async function createApp(): Promise<App> {
  const db = await openDb();
  await migrate(db);
  await seedPlans(db);
  await loadBlocks(db);
  const payments = config.paymentProvider === 'mock' ? new MockPayments(db) : new CinetPayPayments();
  const payouts = config.payoutProvider === 'mock' ? new MockPayouts() : new CinetPayPayouts();
  const stripe = config.stripe.secretKey ? new StripePayments(db) : undefined;
  setBudgetGuard(createDbBudgetGuard(db)); // coupe-circuit de dépense API (§1.3)
  return { db, payments, payouts, stripe };
}

async function main() {
  const problems = assertProductionConfig();
  if (problems.length) { console.error('Configuration de production invalide :\n - ' + problems.join('\n - ')); process.exit(1); }
  const app = await createApp();
  const admin = await bootstrapAdmin(app.db);
  if (admin === 'created') console.log('Administrateur initial créé depuis l\'environnement. Retirez ADMIN_INITIAL_PASSWORD de la configuration.');
  if (admin === 'skipped') console.warn('Aucun administrateur : définissez ADMIN_EMAIL et ADMIN_INITIAL_PASSWORD (16 caractères min.) puis redémarrez.');
  if (config.paymentProvider === 'mock') console.warn('⚠ Mode démonstration : paiements et transferts simulés (aucune somme réelle).');
  const server = createHttpServer(app);
  const stopJobs = config.jobsEnabled ? startJobs(app) : () => undefined;
  server.listen(config.port, () => console.log(`Velyra AI — http://localhost:${config.port}`));
  const stop = async () => { stopJobs(); server.close(); await app.db.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
