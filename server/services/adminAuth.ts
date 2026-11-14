import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { ipPrefix, type Req } from '../lib/http.js';
import { adminPasswordProblems, decrypt, encrypt, hashPassword, randomDigits, randomToken, safeEqual, sha256, verifyPassword } from '../lib/crypto.js';
import { hit, resetKey } from '../lib/ratelimit.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { HttpError, addMinutes, bad, forbidden, nowIso, normalizeEmail, parseJson, uid, unauthorized } from '../lib/util.js';
import { createSession, issueOtp, logLogin, verifyOtp } from './auth.js';
import { notifyEmail, notifyOwner } from './notify.js';
import { logEvent, recordFailedLogin, recordSecuritySignal } from './security.js';

type Step = 'totp_enroll' | 'totp' | 'email_otp';

/**
 * Création de l'administrateur initial à partir de l'ENVIRONNEMENT (jamais depuis le code ou la documentation, §9).
 * Sans effet s'il existe déjà un administrateur.
 */
export async function bootstrapAdmin(db: Db): Promise<'created' | 'exists' | 'skipped'> {
  const has = await db.get(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  if (has) return 'exists';
  if (!config.adminEmail || !config.adminInitialPassword) return 'skipped';
  const problems = adminPasswordProblems(config.adminInitialPassword);
  if (problems.length) throw new Error(`ADMIN_INITIAL_PASSWORD refusé : il faut ${problems.join(', ')}`);
  const now = nowIso();
  await db.run(`INSERT INTO users (id,email,password_hash,email_verified,role,created_at,updated_at) VALUES ($1,$2,$3,1,'admin',$4,$4)
    ON CONFLICT (email) DO UPDATE SET role='admin', password_hash=excluded.password_hash, email_verified=1`, [uid(), config.adminEmail, await hashPassword(config.adminInitialPassword), now]);
  return 'created';
}

export async function loadChallenge(db: Db, id: unknown) {
  const c = await db.get<any>(`SELECT * FROM login_challenges WHERE id=$1`, [String(id ?? '')]);
  if (!c || c.completed_at) throw unauthorized('Session de connexion invalide : recommencez');
  // §9 : chaque tentative de connexion ou de récupération expire au bout de 20 minutes.
  if (c.expires_at < nowIso()) throw new HttpError(401, 'challenge_expired', 'La tentative a expiré (20 minutes). Recommencez la connexion.');
  if (c.attempts >= 8) throw new HttpError(429, 'too_many_attempts', 'Trop d\'essais : recommencez la connexion.');
  return c as { id: string; user_id: string; steps_done: string; device_hash: string | null; ip: string; attempts: number; expires_at: string };
}

async function requiredSteps(db: Db, userId: string, totpEnabled: boolean, deviceHash: string | null, ip: string): Promise<Step[]> {
  const steps: Step[] = [totpEnabled ? 'totp' : 'totp_enroll'];
  // Connexion inhabituelle : appareil jamais vu (identifiant stocké côté navigateur — pas d'empreinte) ou nouveau réseau.
  const known = deviceHash ? await db.get<{ ip_prefix: string }>(`SELECT ip_prefix FROM known_devices WHERE user_id=$1 AND device_hash=$2`, [userId, deviceHash]) : undefined;
  if (!known || known.ip_prefix !== ipPrefix(ip)) steps.push('email_otp');
  return steps;
}

const view = (steps: Step[], done: string[]) => steps.filter((s) => !done.includes(s === 'totp_enroll' ? 'totp' : s));

export async function adminLogin(db: Db, req: Req, b: { email: unknown; password: unknown }) {
  const rl = hit(`adminlogin:${req.ip}`, 10, 600_000);
  if (!rl.allowed) { await recordFailedLogin(db, req.ip, null, 'admin_rate_limited'); throw new HttpError(429, 'rate_limited', 'Trop de tentatives. Réessayez plus tard.'); }
  let email: string; try { email = normalizeEmail(b.email); } catch { throw unauthorized('Identifiants incorrects'); }
  const u = await db.get<any>(`SELECT id,role,status,password_hash,totp_enabled,failed_logins,locked_until FROM users WHERE email=$1`, [email]);
  if (u?.locked_until && u.locked_until > nowIso()) throw new HttpError(423, 'account_locked', 'Compte verrouillé temporairement.');
  const ok = await verifyPassword(String(b.password ?? ''), u?.password_hash);
  if (!u || u.role !== 'admin' || !ok) {
    if (u?.role === 'admin') {
      const n = u.failed_logins + 1, lock = n >= 5;
      await db.run(`UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1`, [u.id, lock ? 0 : n, lock ? addMinutes(30) : null]);
      await logEvent(db, lock ? 'admin_locked' : 'admin_login_failed', lock ? 'high' : 'medium', { ip: req.ip, userId: u.id });
    } else await logEvent(db, 'admin_login_unknown', 'low', { ip: req.ip, detail: { email: email.slice(0, 3) + '…' } });
    await logLogin(db, { userId: u?.id, email, ip: req.ip, ua: req.ua, success: false, reason: 'admin_bad_credentials' });
    await recordFailedLogin(db, req.ip, u?.id ?? null, 'admin_bad_credentials');
    throw unauthorized('Identifiants incorrects');
  }
  if (u.status !== 'active') throw forbidden('Compte désactivé');
  await db.run(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [u.id]);
  const steps = await requiredSteps(db, u.id, !!u.totp_enabled, req.deviceHash, req.ip);
  const id = uid();
  await db.run(`INSERT INTO login_challenges (id,user_id,kind,steps_done,device_hash,ip,user_agent,expires_at,created_at) VALUES ($1,$2,'admin_login','[]',$3,$4,$5,$6,$7)`,
    [id, u.id, req.deviceHash, req.ip, req.ua.slice(0, 300), addMinutes(config.loginAttemptWindowMinutes), nowIso()]);
  // Une clé de sécurité (passkey) enregistrée peut remplacer la saisie du code TOTP à l'étape 'totp' ci-dessus.
  const hasWebauthn = !!(await db.get(`SELECT 1 AS x FROM webauthn_credentials WHERE user_id=$1 LIMIT 1`, [u.id]));
  return { challengeId: id, steps, expiresInMinutes: config.loginAttemptWindowMinutes, hasWebauthn };
}

/** Étape d'inscription 2FA : génère le secret TOTP (affiché une seule fois à l'écran de configuration). */
export async function totpSetup(db: Db, challengeId: unknown) {
  const c = await loadChallenge(db, challengeId);
  const u = await db.get<any>(`SELECT email,totp_enabled FROM users WHERE id=$1`, [c.user_id]);
  if (u.totp_enabled) throw forbidden('La double authentification est déjà configurée');
  const secret = newTotpSecret();
  await db.run(`UPDATE users SET totp_secret_enc=$2 WHERE id=$1`, [c.user_id, encrypt(secret)]);
  return { secret, otpauthUri: otpauthUri(secret, u.email, 'Velyra AI') };
}

export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => `${randomToken(4).replace(/[-_]/g, 'x').slice(0, 5)}-${randomToken(4).replace(/[-_]/g, 'y').slice(0, 5)}`.toLowerCase());
}

export async function totpConfirm(db: Db, challengeId: unknown, code: unknown) {
  const c = await loadChallenge(db, challengeId);
  await db.run(`UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1`, [c.id]);
  const u = await db.get<any>(`SELECT totp_secret_enc,totp_enabled FROM users WHERE id=$1`, [c.user_id]);
  if (u.totp_enabled || !u.totp_secret_enc) throw forbidden('Configuration 2FA impossible');
  if (!verifyTotp(decrypt(u.totp_secret_enc), String(code ?? ''))) throw bad('totp_invalid', 'Code incorrect');
  // Codes de secours : générés aléatoirement, affichés UNE fois, stockés uniquement hachés (§9).
  const codes = newRecoveryCodes();
  await db.run(`UPDATE users SET totp_enabled=1, recovery_codes=$2 WHERE id=$1`, [c.user_id, JSON.stringify(codes.map((x) => sha256(`recovery:${c.user_id}:${x}`)))]);
  const done = parseJson<string[]>(c.steps_done, []);
  done.push('totp');
  await db.run(`UPDATE login_challenges SET steps_done=$2 WHERE id=$1`, [c.id, JSON.stringify(done)]);
  return { recoveryCodes: codes };
}

export async function sendEmailOtp(db: Db, challengeId: unknown) {
  const c = await loadChallenge(db, challengeId);
  const u = await db.get<any>(`SELECT email FROM users WHERE id=$1`, [c.user_id]);
  const code = await issueOtp(db, c.user_id, 'admin_step_up', u.email);
  await notifyEmail(db, u.email, 'Code de connexion administrateur Velyra AI', `Code : ${code}\nValable ${config.otpTtlMinutes} minutes. Connexion depuis un nouvel appareil ou réseau. Si ce n'est pas vous, changez votre mot de passe immédiatement.`, { sensitive: true });
}

export async function adminVerify(db: Db, req: Req, b: { challengeId: unknown; step: unknown; code: unknown }) {
  const c = await loadChallenge(db, b.challengeId);
  const u = await db.get<any>(`SELECT id,email,totp_secret_enc,totp_enabled,recovery_codes FROM users WHERE id=$1`, [c.user_id]);
  await db.run(`UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1`, [c.id]);
  const step = String(b.step ?? ''), code = String(b.code ?? '').trim();
  const done = parseJson<string[]>(c.steps_done, []);
  let ok = false;
  if (step === 'totp' && u.totp_enabled) ok = verifyTotp(decrypt(u.totp_secret_enc), code);
  else if (step === 'recovery' && u.totp_enabled) {
    const list = parseJson<string[]>(u.recovery_codes, []);
    const h = sha256(`recovery:${u.id}:${code.toLowerCase()}`);
    const i = list.findIndex((x) => safeEqual(x, h));
    if (i >= 0) { list.splice(i, 1); await db.run(`UPDATE users SET recovery_codes=$2 WHERE id=$1`, [u.id, JSON.stringify(list)]); ok = true; await logEvent(db, 'admin_recovery_code_used', 'high', { ip: req.ip, userId: u.id, detail: { remaining: list.length } }); }
  } else if (step === 'email_otp') {
    try { await verifyOtp(db, u.id, 'admin_step_up', code); ok = true; } catch (e) { if (e instanceof HttpError && e.code !== 'otp_invalid') throw e; }
  }
  if (!ok) { await logEvent(db, 'admin_2fa_failed', 'medium', { ip: req.ip, userId: u.id, detail: { step } }); await recordSecuritySignal(db, req.ip, 'admin_2fa_failed'); throw bad('code_invalid', 'Code incorrect'); }
  done.push(step === 'recovery' ? 'totp' : step);
  await db.run(`UPDATE login_challenges SET steps_done=$2 WHERE id=$1`, [c.id, JSON.stringify(done)]);
  return finishIfComplete(db, req, c, done);
}

export async function finishIfComplete(db: Db, req: Req, c: any, done: string[]) {
  const user = await db.get<any>(`SELECT totp_enabled FROM users WHERE id=$1`, [c.user_id]);
  const steps = await requiredSteps(db, c.user_id, !!user.totp_enabled || done.includes('totp'), c.device_hash, c.ip);
  const remaining = view(steps, done);
  if (remaining.length) return { done: false, remaining };
  const claim = await db.run(`UPDATE login_challenges SET completed_at=$2 WHERE id=$1 AND completed_at IS NULL`, [c.id, nowIso()]);
  if (!claim.changes) throw unauthorized('Session de connexion déjà utilisée');
  const known = c.device_hash ? await db.get(`SELECT 1 AS x FROM known_devices WHERE user_id=$1 AND device_hash=$2`, [c.user_id, c.device_hash]) : undefined;
  if (c.device_hash) await db.run(`INSERT INTO known_devices (user_id,device_hash,ip_prefix,first_seen,last_seen) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (user_id,device_hash) DO UPDATE SET ip_prefix=excluded.ip_prefix, last_seen=excluded.last_seen`, [c.user_id, c.device_hash, ipPrefix(c.ip), nowIso()]);
  const s = await createSession(db, c.user_id, { ip: c.ip, ua: req.ua, deviceHash: c.device_hash }, true);
  await logLogin(db, { userId: c.user_id, email: undefined, ip: c.ip, ua: req.ua, success: true, reason: 'admin' });
  await logEvent(db, 'admin_login', known ? 'info' : 'medium', { ip: c.ip, userId: c.user_id, detail: { newDevice: !known } });
  if (!known) await notifyOwner(db, 'Connexion administrateur depuis un nouvel appareil', `IP : ${c.ip}\nNavigateur : ${req.ua.slice(0, 120)}\nSi ce n'est pas vous, révoquez la session et changez votre mot de passe.`);
  resetKey(`adminlogin:${req.ip}`);
  return { done: true, token: s.token, expiresAt: s.expiresAt };
}

/** Appelé après totpConfirm pour finaliser si c'était la seule étape restante. */
export async function afterEnroll(db: Db, req: Req, challengeId: unknown) {
  const c = await loadChallenge(db, challengeId);
  return finishIfComplete(db, req, c, parseJson<string[]>((await db.get<any>(`SELECT steps_done FROM login_challenges WHERE id=$1`, [c.id])).steps_done, []));
}
export { randomDigits };
