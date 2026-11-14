import { runIntegrity } from './services/integrity.js';
import type { App } from './app.js';
import { config } from './config.js';
import { sweep } from './lib/ratelimit.js';
import { nowIso } from './lib/util.js';
import * as ops from './services/ops.js';
import * as pay from './services/payments.js';
import * as payouts from './services/payouts.js';
import { runInsights } from './services/insights.js';
import { runDaily } from './services/sysagents.js';
import { purgeExpiredBlocks } from './services/security.js';
import { purgeHoneypot } from './services/honeypot.js';

/** Tâches planifiées (une seule instance du serveur doit les exécuter). Chaque tâche isole ses erreurs. */
export function startJobs(app: App): () => void {
  const { db } = app;
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try { await fn(); } catch (e) { await ops.recordError(db, e, `job:${name}`); } finally { running = false; }
    }, ms);
    t.unref();
    timers.push(t);
  };
  every(60_000, 'payouts', () => payouts.processPayouts(db, app.payouts));
  every(120_000, 'reconcile-payments', async () => { await pay.reconcilePending(db, app.payments); if (app.stripe) await pay.reconcilePending(db, app.stripe); });
  every(300_000, 'health', async () => { await ops.healthCheck(db); await ops.selfMonitor(db); sweep(); });
  every(3_600_000, 'self-heal', () => ops.selfHeal(db));
  every(3_600_000, 'daily', async () => {
    const lastBackup = await db.get<{ created_at: string }>(`SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1`);
    if (!lastBackup || Date.now() - Date.parse(lastBackup.created_at) > 24 * 3_600_000) {
      try { await ops.createBackup(db); } catch (e) { await ops.notifyBackupFailure(db, e); throw e; }
    }
    const lastRun = await db.get<{ started_at: string }>(`SELECT started_at FROM ai_runs ORDER BY started_at DESC LIMIT 1`);
    if (!lastRun || Date.now() - Date.parse(lastRun.started_at) > 24 * 3_600_000) await runInsights(db);
  });
  // Agents IA système : vérification toutes les 30 min ; n'exécute que ce qui manque pour la journée (rattrapage) puis le superviseur.
  every(1_800_000, 'system-agents', () => runDaily(db, 'schedule'));
  // Contrôles d'intégrité légers (SQL pur) : toutes les 30 min, correction immédiate des cas sûrs, alerte immédiate sinon.
  every(1_800_000, 'integrity', async () => { await runIntegrity(db, 'schedule'); });
  // Nettoyage anti-intrusion : blocages IP expirés + purge des informations captées par le piège (honeypot) au-delà de la rétention configurée.
  every(3_600_000, 'security-cleanup', async () => { await purgeExpiredBlocks(db); await purgeHoneypot(db); });
  const boot = setTimeout(() => { runDaily(db, 'startup').catch((e) => ops.recordError(db, e, 'job:system-agents-startup')); }, 45_000);
  boot.unref(); timers.push(boot as unknown as NodeJS.Timeout);
  void config; void nowIso;
  return () => timers.forEach(clearInterval);
}
