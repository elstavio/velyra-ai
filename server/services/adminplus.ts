import type { Db } from '../db/index.js';
import { HttpError, bad, int, nowIso, parseJson, str } from '../lib/util.js';
import { audit } from './admin.js';
import * as tokens from './tokens.js';
import { isKilled } from './publishing.js';
import { LABELS } from '../providers/social.js';
import { recentHits, purgeHoneypot } from './honeypot.js';
import { config } from '../config.js';

const D = 86_400_000;
const since = (days: number) => new Date(Date.now() - days * D).toISOString();

export async function tokensOverview(db: Db) {
  const sold = await db.get<any>(`SELECT COALESCE(SUM(delta),0) AS n, COUNT(*) AS c FROM token_ledger WHERE reason='purchase'`);
  const granted = await db.get<any>(`SELECT COALESCE(SUM(delta),0) AS n FROM token_ledger WHERE reason='admin_grant'`);
  const used = await db.get<any>(`SELECT COALESCE(-SUM(delta),0) AS n FROM token_ledger WHERE reason='task'`);
  const refunded = await db.get<any>(`SELECT COALESCE(SUM(delta),0) AS n FROM token_ledger WHERE reason='refund'`);
  const outstanding = await db.get<any>(`SELECT COALESCE(SUM(balance),0) AS n, COUNT(*) AS holders FROM token_balances WHERE balance > 0`);
  const top = await db.query<any>(`SELECT u.email, b.balance FROM token_balances b JOIN users u ON u.id=b.user_id WHERE b.balance > 0 ORDER BY b.balance DESC LIMIT 10`);
  const low = await db.query<any>(`SELECT u.email, b.balance FROM token_balances b JOIN users u ON u.id=b.user_id WHERE b.balance BETWEEN 1 AND 10 ORDER BY b.balance LIMIT 20`);
  const recent = await db.query<any>(`SELECT l.created_at, u.email, l.delta, l.reason, l.note FROM token_ledger l JOIN users u ON u.id=l.user_id WHERE l.reason <> 'task' ORDER BY l.created_at DESC LIMIT 40`);
  const packs = await db.query<any>(`SELECT p.plan_code, COUNT(*) AS n, COALESCE(SUM(p.amount),0) AS revenue, p.currency FROM payments p WHERE p.status='succeeded' AND p.plan_code LIKE 'tokens_%' GROUP BY p.plan_code, p.currency ORDER BY p.plan_code`);
  return { sold: Number(sold.n), purchases: Number(sold.c), granted: Number(granted.n), used: Number(used.n), refunded: Number(refunded.n), outstanding: Number(outstanding.n), holders: Number(outstanding.holders), top, low, recent, packs, note: 'Les jetons n\'expirent jamais. 1 jeton = 1 tâche IA.' };
}

export async function adjustTokens(db: Db, adminId: string, b: any) {
  let userId = b?.userId ? String(b.userId) : '';
  if (!userId && b?.email) { const u = await db.get<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [String(b.email).trim().toLowerCase()]); if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable'); userId = u.id; }
  if (!userId) throw bad('user_required', 'Indiquez un email ou un identifiant utilisateur');
  const delta = int(b?.delta, 'quantité', { min: -1_000_000, max: 1_000_000 }) ; const reason = str(b?.reason, 'motif', { min: 3, max: 200 });
  const bal = await tokens.adminAdjust(db, userId, delta, reason);
  await audit(db, adminId, 'tokens_adjust', userId, { delta, reason, balance: bal });
  return { balance: bal };
}

export async function socialOverview(db: Db) {
  const accounts = await db.query<any>(`SELECT platform, status, COUNT(*) AS n FROM social_accounts GROUP BY platform, status ORDER BY platform`);
  const posts = await db.query<any>(`SELECT p.id, p.platform, p.status, p.created_by, p.created_at, p.published_at, p.error, u.email, substr(p.body,1,120) AS excerpt,
      (SELECT COUNT(*) FROM post_approvals a WHERE a.post_id=p.id) AS approvals FROM social_posts p JOIN users u ON u.id=p.user_id WHERE p.status <> 'discarded' ORDER BY p.created_at DESC LIMIT 100`);
  const byStatus = await db.query<any>(`SELECT status, COUNT(*) AS n FROM social_posts GROUP BY status`);
  // Garantie vérifiable : toute publication « published » doit avoir une validation journalisée.
  const unapproved = (await db.get<any>(`SELECT COUNT(*) AS n FROM social_posts p WHERE p.status='published' AND NOT EXISTS (SELECT 1 FROM post_approvals a WHERE a.post_id=p.id AND a.authorized=1 AND a.verified=1 AND a.content_hash=p.content_hash)`)).n;
  return { platforms: Object.keys(LABELS), accounts, posts, byStatus, killed: await isKilled(db), publishedWithoutApproval: Number(unapproved) };
}
export async function setKill(db: Db, adminId: string, on: boolean) {
  if (on) await db.run(`INSERT INTO settings (key,value) VALUES ('kill.publish','1') ON CONFLICT (key) DO UPDATE SET value='1'`); else await db.run(`DELETE FROM settings WHERE key='kill.publish'`);
  await audit(db, adminId, on ? 'publishing_suspended' : 'publishing_resumed', 'social'); return { killed: on };
}

/** Fiche 360° d'un utilisateur : tout ce qu'il faut pour vérifier un compte sans fouiller plusieurs écrans. Aucun jeton d'accès n'est renvoyé. */
export async function userOverview(db: Db, id: string) {
  const u = await db.get<any>(`SELECT id,email,role,status,country,email_verified,phone,phone_verified,trials_used,totp_enabled,created_at FROM users WHERE id=$1`, [id]);
  if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
  const q = (sql: string) => db.query<any>(sql, [id]);
  return {
    user: u,
    tokens: { balance: await tokens.getBalance(db, id), history: await tokens.history(db, id, 20) },
    subscriptions: await q(`SELECT plan_code, starts_at, ends_at FROM subscriptions WHERE user_id=$1 ORDER BY ends_at DESC LIMIT 10`),
    payments: await q(`SELECT provider_ref, plan_code, amount, currency, channel, status, fraud_flag, created_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`),
    social: await q(`SELECT platform, display_name, status, synced_at, last_error FROM social_accounts WHERE user_id=$1 ORDER BY created_at`),
    posts: await q(`SELECT platform, status, created_by, created_at, published_at, substr(body,1,100) AS excerpt FROM social_posts WHERE user_id=$1 AND status <> 'discarded' ORDER BY created_at DESC LIMIT 10`),
    tasks: (await db.get<any>(`SELECT COUNT(*) AS n FROM tasks WHERE user_id=$1 AND created_at >= $2`, [id, since(30)]))!.n,
    sessions: await q(`SELECT ip, user_agent, created_at, last_seen_at, revoked_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`),
    logins: await db.query<any>(`SELECT ip, success, reason, created_at FROM login_log WHERE email=$1 ORDER BY created_at DESC LIMIT 10`, [u.email]).catch(() => []),
  };
}

/** Vue financière : revenus par jour/devise, par offre, paiements refusés ou retenus. */
export async function finance(db: Db, days: number) {
  days = Math.min(365, Math.max(1, days | 0 || 30)); const from = since(days);
  const byDay = await db.query<any>(`SELECT substr(confirmed_at,1,10) AS day, currency, COUNT(*) AS n, SUM(amount) AS total FROM payments WHERE status='succeeded' AND confirmed_at >= $1 GROUP BY substr(confirmed_at,1,10), currency ORDER BY day`, [from]);
  const byPlan = await db.query<any>(`SELECT plan_code, currency, COUNT(*) AS n, SUM(amount) AS total FROM payments WHERE status='succeeded' AND confirmed_at >= $1 GROUP BY plan_code, currency ORDER BY total DESC`, [from]);
  const byChannel = await db.query<any>(`SELECT channel, COUNT(*) AS n, SUM(amount) AS total, currency FROM payments WHERE status='succeeded' AND confirmed_at >= $1 GROUP BY channel, currency ORDER BY total DESC`, [from]);
  const status = await db.query<any>(`SELECT status, COUNT(*) AS n FROM payments WHERE created_at >= $1 GROUP BY status`, [from]);
  const flagged = (await db.get<any>(`SELECT COUNT(*) AS n FROM payments WHERE fraud_flag=1 AND created_at >= $1`, [from]))!.n;
  const active = (await db.get<any>(`SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE ends_at > $1 AND starts_at <= $1`, [nowIso()]))!.n;
  return { days, byDay, byPlan, byChannel, status, flagged: Number(flagged), activeSubscribers: Number(active) };
}

/** Vue sécurité consolidée : intrusions piégées, blocages actifs, retraits en attente de confirmation, nouveaux appareils. */
export async function securityOverview(db: Db) {
  const honeypot = await recentHits(db, 50);
  const honeypotTotal = (await db.get<any>(`SELECT COUNT(*) AS n FROM honeypot_hits`))!.n;
  const blocks = await db.query<any>(`SELECT ip,reason,permanent,created_at,expires_at FROM ip_blocks ORDER BY created_at DESC LIMIT 100`);
  const pendingPayouts = await db.query<any>(`SELECT c.payout_id, c.status, c.created_at, c.expires_at, c.sent_count, p.amount, p.currency FROM payout_confirmations c JOIN payouts p ON p.id=c.payout_id WHERE c.status='pending' ORDER BY c.created_at DESC`);
  const newDevices = await db.query<any>(`SELECT created_at, ip, user_id, detail FROM security_events WHERE type='new_device_login' ORDER BY created_at DESC LIMIT 30`);
  const criticalEvents = await db.query<any>(`SELECT id,type,severity,ip,user_id,detail,created_at FROM security_events WHERE severity IN ('high','critical') ORDER BY created_at DESC LIMIT 30`);
  const burstBlocks24h = (await db.get<any>(`SELECT COUNT(*) AS n FROM security_events WHERE type='ip_blocked' AND created_at >= $1`, [since(1)]))!.n;
  return { honeypot, honeypotTotal: Number(honeypotTotal), blocks, pendingPayouts, newDevices, criticalEvents, burstBlocks24h: Number(burstBlocks24h), retentionDays: config.honeypotRetentionDays };
}
export async function purgeHoneypotNow(db: Db, adminId: string) {
  const n = await purgeHoneypot(db);
  await audit(db, adminId, 'honeypot_purged', 'manual', { deleted: n });
  return { deleted: n };
}

/**
 * Coffre-fort de secrets — vue de statut uniquement.
 *
 * Les secrets eux-mêmes (clés API, jetons) ne sont ni stockés ni affichés par l'application : ils vivent
 * exclusivement dans les variables d'environnement de l'hébergeur (Render, etc.), ce qui reste la pratique
 * recommandée (rotation, accès restreint à la plateforme, jamais commis dans le code). Cette vue se contente
 * d'indiquer quels secrets sont configurés, lesquels manquent, et la date de rotation que VOUS déclarez vous-même
 * après avoir changé une clé chez le fournisseur — l'application ne peut pas tourner une clé externe à votre place.
 */
const SECRET_CATALOG = [
  { key: 'ENCRYPTION_KEY', label: 'Clé de chiffrement (numéros de virement, jetons OAuth, sauvegardes)', critical: true, present: () => !!config.encryptionKey },
  { key: 'DATABASE_URL', label: 'Connexion PostgreSQL', critical: true, present: () => !!config.databaseUrl },
  { key: 'ADMIN_INITIAL_PASSWORD', label: 'Mot de passe admin initial (à retirer après le premier démarrage)', critical: true, present: () => !!config.adminInitialPassword, warnIfPresent: 'Toujours défini : retirez-le de l\'environnement après le premier démarrage.' },
  { key: 'CINETPAY_SECRET_KEY', label: 'CinetPay (paiements/virements)', critical: true, present: () => !!config.cinetpay.secretKey },
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe', critical: false, present: () => !!config.stripe.secretKey },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe — secret de webhook', critical: false, present: () => !!config.stripe.webhookSecret },
  { key: 'RESEND_API_KEY', label: 'Resend (email)', critical: true, present: () => !!config.resendApiKey },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio (SMS)', critical: false, present: () => !!config.twilio.authToken },
  { key: 'CRON_SECRET', label: 'Secret du planificateur externe (/api/cron/daily)', critical: false, present: () => !!config.cronSecret },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (IA)', critical: false, present: () => !!config.ai.anthropic.key },
  { key: 'OPENAI_API_KEY', label: 'OpenAI (IA)', critical: false, present: () => !!config.ai.openai.key },
  { key: 'MISTRAL_API_KEY', label: 'Mistral (IA)', critical: false, present: () => !!config.ai.mistral.key },
  { key: 'TIKTOK_CLIENT_SECRET', label: 'TikTok (réseaux)', critical: false, present: () => !!config.social.tiktok.clientSecret },
  { key: 'YOUTUBE_CLIENT_SECRET', label: 'YouTube/Google (réseaux)', critical: false, present: () => !!config.social.youtube.clientSecret },
  { key: 'META_APP_SECRET', label: 'Meta — Facebook/Instagram/WhatsApp (réseaux)', critical: false, present: () => !!config.social.meta.appSecret },
];
export async function secretsOverview(db: Db) {
  const rotations = await db.query<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key LIKE 'secret_rotated:%'`);
  const rotatedAt = new Map(rotations.map((r) => [r.key.replace('secret_rotated:', ''), r.value]));
  const items = SECRET_CATALOG.map((s) => ({ key: s.key, label: s.label, critical: s.critical, present: s.present(), rotatedAt: rotatedAt.get(s.key) ?? null, warn: s.present() && s.warnIfPresent ? s.warnIfPresent : null }));
  const missingCritical = items.filter((i) => i.critical && !i.present);
  return { items, missingCritical: missingCritical.map((i) => i.key) };
}
export async function declareSecretRotated(db: Db, adminId: string, key: string) {
  const entry = SECRET_CATALOG.find((s) => s.key === key);
  if (!entry) throw new HttpError(404, 'not_found', 'Secret inconnu');
  await db.run(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [`secret_rotated:${key}`, nowIso()]);
  await audit(db, adminId, 'secret_rotation_declared', key);
  return { ok: true };
}

// ---------------------------------------------------------------- exports CSV (neutralisation des formules : =, +, -, @)
const cell = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (head: string[], rows: any[]) => [head.join(';'), ...rows.map((r) => head.map((h) => cell(r[h])).join(';'))].join('\n') + '\n';
export async function exportCsv(db: Db, kind: string): Promise<{ name: string; csv: string }> {
  if (kind === 'payments') return { name: 'paiements.csv', csv: toCsv(['created_at', 'provider_ref', 'email', 'plan_code', 'amount', 'currency', 'channel', 'provider', 'status', 'fraud_flag'], await db.query(`SELECT p.created_at, p.provider_ref, u.email, p.plan_code, p.amount, p.currency, p.channel, p.provider, p.status, p.fraud_flag FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 20000`)) };
  if (kind === 'users') return { name: 'utilisateurs.csv', csv: toCsv(['created_at', 'email', 'country', 'status', 'email_verified', 'phone_verified', 'trials_used', 'tokens'], await db.query(`SELECT u.created_at, u.email, u.country, u.status, u.email_verified, u.phone_verified, u.trials_used, COALESCE(b.balance,0) AS tokens FROM users u LEFT JOIN token_balances b ON b.user_id=u.id WHERE u.role='user' ORDER BY u.created_at DESC LIMIT 20000`)) };
  if (kind === 'tokens') return { name: 'jetons.csv', csv: toCsv(['created_at', 'email', 'delta', 'balance_after', 'reason', 'note'], await db.query(`SELECT l.created_at, u.email, l.delta, l.balance_after, l.reason, l.note FROM token_ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 20000`)) };
  if (kind === 'posts') return { name: 'publications.csv', csv: toCsv(['created_at', 'email', 'platform', 'status', 'created_by', 'published_at', 'approvals', 'remote_id', 'error'], await db.query(`SELECT p.created_at, u.email, p.platform, p.status, p.created_by, p.published_at, (SELECT COUNT(*) FROM post_approvals a WHERE a.post_id=p.id) AS approvals, p.remote_id, p.error FROM social_posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 20000`)) };
  throw new HttpError(404, 'not_found', 'Export inconnu');
}
void parseJson;
