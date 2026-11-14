import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, forbidden, nowIso, parseJson, uid } from '../lib/util.js';
import type { UserRow } from './auth.js';
import * as tokens from './tokens.js';

export interface Entitlements {
  trialsTotal: number; trialsUsed: number; trialsRemaining: number;
  subscriptions: { planCode: string; endsAt: string }[];
  features: string[]; tokens: number; platformAccess: boolean; tiktokAdvanced: boolean; socialAccess: boolean; onTrial: boolean;
}

export async function getEntitlements(db: Db, user: Pick<UserRow, 'id' | 'trials_used'>): Promise<Entitlements> {
  const subs = await db.query<{ plan_code: string; ends_at: string; features: string }>(
    `SELECT s.plan_code, s.ends_at, p.features FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.user_id=$1 AND s.ends_at > $2 AND s.starts_at <= $2`, [user.id, nowIso()]);
  const features = new Set<string>();
  for (const s of subs) for (const f of parseJson<string[]>(s.features, [])) features.add(f);
  const trialsRemaining = Math.max(0, config.trialTasks - user.trials_used);
  return {
    trialsTotal: config.trialTasks, trialsUsed: user.trials_used, trialsRemaining,
    subscriptions: subs.map((s) => ({ planCode: s.plan_code, endsAt: s.ends_at })),
    features: [...features], tokens: await tokens.getBalance(db, user.id), platformAccess: features.has('platform'), tiktokAdvanced: features.has('tiktok_advanced'), socialAccess: features.has('social'),
    onTrial: !features.has('platform') && trialsRemaining > 0,
  };
}

export class PaywallError extends HttpError {
  constructor(message = `Vos ${config.trialTasks} essais gratuits sont épuisés. Choisissez une offre pour continuer.`) {
    super(402, 'trial_exhausted', message, { paywall: true });
  }
}

export interface TaskHandle { id: string; billing: 'trial' | 'subscription' | 'tokens' }

/**
 * Réserve une « tâche » avant d'exécuter un service. Essai : décrément atomique (aucun dépassement possible,
 * même avec des requêtes simultanées). Abonné : limite d'usage équitable quotidienne.
 */
export async function startTask(db: Db, user: UserRow, kind: string, input: unknown): Promise<TaskHandle> {
  if (user.status !== 'active') throw forbidden('Compte suspendu', 'account_disabled');
  if (!user.email_verified) throw forbidden('Vérifiez votre adresse email pour utiliser la plateforme', 'email_unverified');
  if (user.extra_verification && !user.phone_verified) throw forbidden('Vérification supplémentaire requise : confirmez votre numéro de téléphone par SMS', 'extra_verification_required');
  const ent = await getEntitlements(db, user);
  const id = uid();
  const inputStr = JSON.stringify(input ?? {}).slice(0, 4000);
  const insert = (billing: string) => db.run(`INSERT INTO tasks (id,user_id,kind,input,billing,status,created_at) VALUES ($1,$2,$3,$4,$5,'running',$6)`, [id, user.id, kind, inputStr, billing, nowIso()]);
  let capReached = false;
  if (ent.platformAccess) {
    const today = new Date().toISOString().slice(0, 10);
    const n = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE user_id=$1 AND created_at >= $2 AND billing='subscription'`, [user.id, today]);
    capReached = (n?.n ?? 0) >= config.dailyTaskCap;
    if (!capReached) { await insert('subscription'); return { id, billing: 'subscription' }; }
  }
  // Ordre de consommation : abonnement (usage équitable) → essais gratuits → jetons achetés.
  const canTrial = !ent.platformAccess && ent.trialsRemaining > 0 && !!user.phone_verified;
  if (canTrial) {
    const r = await db.run(`UPDATE users SET trials_used = trials_used + 1 WHERE id=$1 AND trials_used < $2`, [user.id, config.trialTasks]);
    if (r.changes) { await insert('trial'); return { id, billing: 'trial' }; }
  }
  if (ent.tokens > 0 && await tokens.spendOne(db, user.id, id, user.email)) { await insert('tokens'); return { id, billing: 'tokens' }; }
  if (capReached) throw new HttpError(429, 'daily_cap', `Limite quotidienne d'usage équitable atteinte (${config.dailyTaskCap} tâches). Réessayez demain ou rechargez des jetons.`);
  if (!ent.platformAccess && ent.trialsRemaining > 0 && !user.phone_verified) throw forbidden('Confirmez votre numéro de téléphone par SMS pour activer vos essais gratuits (un compte par numéro).', 'phone_required');
  throw new PaywallError();
}

export async function finishTask(db: Db, t: TaskHandle, output: unknown) {
  await db.run(`UPDATE tasks SET status='done', output=$2 WHERE id=$1`, [t.id, JSON.stringify(output ?? {}).slice(0, 20000)]);
}
/** Échec côté plateforme (ex. fournisseur d'IA indisponible) : l'essai consommé est restitué. */
export async function failTask(db: Db, userId: string, t: TaskHandle, error: string) {
  await db.run(`UPDATE tasks SET status='failed', output=$2 WHERE id=$1 AND status='running'`, [t.id, JSON.stringify({ error }).slice(0, 500)]);
  if (t.billing === 'tokens') await tokens.refundOne(db, userId, t.id);
  if (t.billing === 'trial') await db.run(`UPDATE users SET trials_used = trials_used - 1 WHERE id=$1 AND trials_used > 0`, [userId]);
}

/** Exécute `fn` dans le cadre d'une tâche facturée, avec restitution de l'essai en cas d'erreur. */
export async function withTask<T>(db: Db, user: UserRow, kind: string, input: unknown, fn: (t: TaskHandle) => Promise<T>): Promise<{ result: T; billing: TaskHandle['billing'] }> {
  const t = await startTask(db, user, kind, input);
  try {
    const result = await fn(t);
    await finishTask(db, t, typeof result === 'object' ? { ok: true } : result);
    return { result, billing: t.billing };
  } catch (e: any) {
    await failTask(db, user.id, t, String(e?.message ?? e));
    throw e;
  }
}
