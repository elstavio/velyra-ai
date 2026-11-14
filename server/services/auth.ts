import type { Db } from '../db/index.js';
import { config } from '../config.js';
import type { AuthedUser, Req } from '../lib/http.js';
import { ipPrefix } from '../lib/http.js';
import { hashPassword, randomDigits, randomToken, safeEqual, sha256, userPasswordProblems, verifyPassword } from '../lib/crypto.js';
import { verifyAppleIdToken, verifyGoogleIdToken } from '../lib/oidc.js';
import { hit, resetKey } from '../lib/ratelimit.js';
import { HttpError, addMinutes, bad, conflict, forbidden, nowIso, normalizeEmail, normalizePhone, uid, unauthorized } from '../lib/util.js';
import { notifyEmail, notifySms } from './notify.js';
import { checkAndRecordDevice, logEvent, recordFailedLogin } from './security.js';
import { COUNTRIES } from '../data/regions.js';

export const USER_COLS = `id,email,role,status,country,email_verified,phone,phone_verified,trials_used,totp_enabled,created_at,extra_verification`;

export interface UserRow extends AuthedUser { extra_verification: number; password_hash?: string | null }

export function publicUser(u: UserRow) {
  return {
    id: u.id, email: u.email, role: u.role, country: u.country, emailVerified: !!u.email_verified,
    phone: u.phone ? u.phone.slice(0, 4) + '•••' + u.phone.slice(-2) : null, phoneVerified: !!u.phone_verified,
    createdAt: u.created_at, needsExtraVerification: !!u.extra_verification,
  };
}

// ----------------------------------------------------------------------------- OTP
type Purpose = 'email_verify' | 'phone_verify' | 'password_reset' | 'admin_step_up' | 'delete_account' | 'login_code';

export async function issueOtp(db: Db, userId: string, purpose: Purpose, target: string): Promise<string> {
  const rl = hit(`otp:${purpose}:${target}`, config.otpSendPerTargetPerHour, 3_600_000);
  if (!rl.allowed) throw new HttpError(429, 'otp_rate_limited', `Trop de codes demandés. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.`);
  const code = randomDigits(6);
  await db.run(`UPDATE otp_codes SET consumed_at=$3 WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL`, [userId, purpose, nowIso()]);
  await db.run(`INSERT INTO otp_codes (id,user_id,purpose,target,code_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uid(), userId, purpose, target, sha256(`${userId}:${purpose}:${code}`), addMinutes(config.otpTtlMinutes), nowIso()]);
  return code;
}

/** Vérifie un code ; 5 essais maximum par code, usage unique, expiration (10 min par défaut). */
export async function verifyOtp(db: Db, userId: string, purpose: Purpose, code: string): Promise<{ target: string }> {
  const row = await db.get<any>(`SELECT * FROM otp_codes WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId, purpose]);
  if (!row || row.expires_at < nowIso()) throw bad('otp_expired', 'Code expiré ou inexistant : demandez-en un nouveau');
  if (row.attempts >= config.otpMaxAttempts) throw bad('otp_locked', 'Trop de tentatives : demandez un nouveau code');
  await db.run(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1`, [row.id]);
  if (!safeEqual(row.code_hash, sha256(`${userId}:${purpose}:${String(code).trim()}`))) throw bad('otp_invalid', 'Code incorrect');
  const c = await db.run(`UPDATE otp_codes SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL`, [row.id, nowIso()]);
  if (!c.changes) throw bad('otp_invalid', 'Code déjà utilisé');
  return { target: row.target };
}

// ----------------------------------------------------------------------------- sessions
export async function logLogin(db: Db, r: { userId?: string | null; email?: string; ip: string; ua: string; success: boolean; reason?: string }) {
  await db.run(`INSERT INTO login_logs (id,user_id,email,ip,user_agent,success,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uid(), r.userId ?? null, r.email ?? null, r.ip, r.ua.slice(0, 300), r.success ? 1 : 0, r.reason ?? null, nowIso()]);
}

export async function createSession(db: Db, userId: string, req: Pick<Req, 'ip' | 'ua' | 'deviceHash'>, isAdmin = false): Promise<{ token: string; id: string; expiresAt: string }> {
  const token = randomToken(32), id = uid();
  const expiresAt = isAdmin ? addMinutes(config.adminSessionTtlMinutes) : addMinutes(config.sessionTtlHours * 60);
  await db.run(`INSERT INTO sessions (id,user_id,token_hash,ip,user_agent,device_hash,is_admin,created_at,last_seen_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`,
    [id, userId, sha256(token), req.ip, req.ua.slice(0, 300), req.deviceHash, isAdmin ? 1 : 0, nowIso(), expiresAt]);
  await db.run(`UPDATE users SET last_login_at=$2 WHERE id=$1`, [userId, nowIso()]);
  return { token, id, expiresAt };
}

export async function authenticate(db: Db, token: string | null): Promise<{ user: UserRow; session: { id: string; is_admin: number; created_at: string; expires_at: string; ip: string | null; device_hash: string | null } } | null> {
  if (!token) return null;
  const s = await db.get<any>(`SELECT * FROM sessions WHERE token_hash=$1`, [sha256(token)]);
  if (!s || s.revoked_at || s.expires_at < nowIso()) return null;
  const user = await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [s.user_id]);
  if (!user) return null;
  if (s.is_admin && s.expires_at && s.last_seen_at) {
    // Session admin : expiration glissante limitée par l'inactivité (durée configurable).
    const idleLimit = Date.parse(s.last_seen_at) + config.adminSessionTtlMinutes * 60_000;
    if (idleLimit < Date.now()) return null;
  }
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000) await db.run(`UPDATE sessions SET last_seen_at=$2 WHERE id=$1`, [s.id, nowIso()]);
  return { user, session: { id: s.id, is_admin: s.is_admin, created_at: s.created_at, expires_at: s.expires_at, ip: s.ip, device_hash: s.device_hash } };
}

export async function revokeSession(db: Db, userId: string, sessionId: string) {
  const r = await db.run(`UPDATE sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [sessionId, userId, nowIso()]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Session introuvable');
}
export async function revokeAllSessions(db: Db, userId: string, exceptId?: string) {
  await db.run(`UPDATE sessions SET revoked_at=$3 WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2`, [userId, exceptId ?? '', nowIso()]);
}
export async function listSessions(db: Db, userId: string, currentId: string) {
  const rows = await db.query<any>(`SELECT id,ip,user_agent,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_seen_at DESC`, [userId, nowIso()]);
  return rows.map((r) => ({ id: r.id, ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentId }));
}

// ----------------------------------------------------------------------------- inscription / connexion
export async function register(db: Db, req: Req, b: { email: unknown; password: unknown; country?: unknown }) {
  const rl = hit(`signup:${req.ip}`, config.signupPerIpPerHour, 3_600_000);
  if (!rl.allowed) {
    await logEvent(db, 'signup_rate_limited', 'low', { ip: req.ip });
    throw new HttpError(429, 'rate_limited', `Trop d'inscriptions depuis cette connexion. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.`);
  }
  const email = normalizeEmail(b.email);
  const password = String(b.password ?? '');
  const problems = userPasswordProblems(password);
  if (problems.length) throw bad('weak_password', `Mot de passe trop faible : ${problems.join(', ')}`);
  let country: string | null = null;
  if (b.country) {
    country = String(b.country).toUpperCase();
    if (!COUNTRIES[country]) throw bad('invalid_country', 'Pays inconnu');
  }
  const exists = await db.get(`SELECT id FROM users WHERE email=$1`, [email]);
  if (exists) throw conflict('email_taken', 'Un compte existe déjà avec cet email');

  // Rafale d'inscriptions depuis une même source : jamais de blocage (VPN/cybercafé légitimes), mais vérification supplémentaire.
  const burst = hit(`burst:${req.ip}`, 1_000_000, 15 * 60_000).count >= config.signupBurstThreshold;
  const id = uid(), now = nowIso();
  await db.run(`INSERT INTO users (id,email,password_hash,country,extra_verification,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [id, email, await hashPassword(password), country, burst ? 1 : 0, now]);
  if (burst) {
    await logEvent(db, 'signup_burst', 'medium', { ip: req.ip, userId: id });
    await db.run(`INSERT INTO fraud_reports (id,user_id,source,reason,created_at) VALUES ($1,$2,'auto',$3,$4)`, [uid(), id, 'Rafale d\'inscriptions depuis une même source (vérification supplémentaire requise, revue humaine)', now]);
  }
  await sendEmailCode(db, id, email);
  return { id, email, needsExtraVerification: burst };
}

async function sendEmailCode(db: Db, userId: string, email: string) {
  const code = await issueOtp(db, userId, 'email_verify', email);
  await notifyEmail(db, email, 'Votre code de vérification Velyra AI', `Votre code de vérification : ${code}\nIl expire dans ${config.otpTtlMinutes} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`, { sensitive: true });
}
export async function resendEmailCode(db: Db, user: UserRow) {
  if (user.email_verified) throw conflict('already_verified', 'Email déjà vérifié');
  await sendEmailCode(db, user.id, user.email);
}
export async function verifyEmail(db: Db, user: UserRow, code: unknown) {
  await verifyOtp(db, user.id, 'email_verify', String(code ?? ''));
  await db.run(`UPDATE users SET email_verified=1, updated_at=$2 WHERE id=$1`, [user.id, nowIso()]);
}

export async function login(db: Db, req: Req, b: { email: unknown; password: unknown }) {
  const rl = hit(`login:${req.ip}`, config.loginPerIpPer10Min, 600_000);
  if (!rl.allowed) {
    // Un client qui persiste malgré la limitation est compté : au-delà du seuil, l'IP est bloquée automatiquement (§8).
    await recordFailedLogin(db, req.ip, null, 'rate_limited');
    throw new HttpError(429, 'rate_limited', `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.`);
  }
  let email: string;
  try { email = normalizeEmail(b.email); } catch { throw unauthorized('Email ou mot de passe incorrect'); }
  const u = await db.get<UserRow & { password_hash: string | null; failed_logins: number; locked_until: string | null }>(`SELECT ${USER_COLS},password_hash,failed_logins,locked_until FROM users WHERE email=$1`, [email]);
  const fail = async (reason: string) => {
    await logLogin(db, { userId: u?.id, email, ip: req.ip, ua: req.ua, success: false, reason });
    await recordFailedLogin(db, req.ip, u?.id ?? null, reason);
    throw unauthorized('Email ou mot de passe incorrect');
  };
  if (u?.locked_until && u.locked_until > nowIso()) {
    await logLogin(db, { userId: u.id, email, ip: req.ip, ua: req.ua, success: false, reason: 'locked' });
    throw new HttpError(423, 'account_locked', 'Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard.');
  }
  const ok = await verifyPassword(String(b.password ?? ''), u?.password_hash);
  if (!u || !ok) {
    if (u) {
      const n = u.failed_logins + 1;
      const lock = n >= config.failedLoginsBeforeLock;
      await db.run(`UPDATE users SET failed_logins=$2, locked_until=$3 WHERE id=$1`, [u.id, lock ? 0 : n, lock ? addMinutes(config.accountLockMinutes) : null]);
      if (lock) await logEvent(db, 'account_locked', 'medium', { ip: req.ip, userId: u.id, detail: { minutes: config.accountLockMinutes } });
    }
    return fail(u ? 'bad_password' : 'unknown_email');
  }
  if (u.role === 'admin') { await logLogin(db, { userId: u.id, email, ip: req.ip, ua: req.ua, success: false, reason: 'admin_via_user_login' }); throw unauthorized('Email ou mot de passe incorrect'); }
  if (u.status !== 'active') { await logLogin(db, { userId: u.id, email, ip: req.ip, ua: req.ua, success: false, reason: `status_${u.status}` }); throw forbidden('Compte suspendu ou révoqué. Contactez le support.', 'account_disabled'); }
  await db.run(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [u.id]);
  resetKey(`login:${req.ip}`);
  await logLogin(db, { userId: u.id, email, ip: req.ip, ua: req.ua, success: true });
  const s = await createSession(db, u.id, req);
  await checkAndRecordDevice(db, { id: u.id, email: u.email }, req.ip, req.ua, req.deviceHash);
  return { token: s.token, expiresAt: s.expiresAt, user: publicUser(u) };
}

export async function loginWithGoogle(db: Db, req: Req, credential: unknown) {
  let id;
  try { id = await verifyGoogleIdToken(String(credential ?? '')); } catch (e: any) {
    await logLogin(db, { email: undefined, ip: req.ip, ua: req.ua, success: false, reason: 'google_token_invalid' });
    await recordFailedLogin(db, req.ip, null, 'google_token_invalid');
    throw unauthorized('Connexion Google refusée');
  }
  if (!id.emailVerified) throw unauthorized('Email Google non vérifié');
  let u = await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE google_sub=$1 OR email=$2`, [id.sub, id.email]);
  if (!u) {
    const uidv = uid(), now = nowIso();
    await db.run(`INSERT INTO users (id,email,google_sub,email_verified,created_at,updated_at) VALUES ($1,$2,$3,1,$4,$4)`, [uidv, id.email, id.sub, now]);
    u = (await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [uidv]))!;
  } else {
    if (u.role === 'admin') throw unauthorized('Connexion Google non autorisée pour ce compte');
    await db.run(`UPDATE users SET google_sub=$2, email_verified=1 WHERE id=$1`, [u.id, id.sub]);
  }
  if (u.status !== 'active') throw forbidden('Compte suspendu ou révoqué. Contactez le support.', 'account_disabled');
  await logLogin(db, { userId: u.id, email: u.email, ip: req.ip, ua: req.ua, success: true, reason: 'google' });
  const s = await createSession(db, u.id, req);
  await checkAndRecordDevice(db, { id: u.id, email: u.email }, req.ip, req.ua, req.deviceHash);
  return { token: s.token, expiresAt: s.expiresAt, user: publicUser({ ...u, email_verified: 1 }) };
}

export async function loginWithApple(db: Db, req: Req, idToken: unknown, nonce: unknown) {
  let id;
  try { id = await verifyAppleIdToken(String(idToken ?? ''), String(nonce ?? '')); } catch {
    await logLogin(db, { email: undefined, ip: req.ip, ua: req.ua, success: false, reason: 'apple_token_invalid' });
    await recordFailedLogin(db, req.ip, null, 'apple_token_invalid');
    throw unauthorized('Connexion Apple refusée');
  }
  if (!id.emailVerified) throw unauthorized('Email Apple non vérifié');
  let u = await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE apple_sub=$1 OR email=$2`, [id.sub, id.email]);
  if (!u) {
    const uidv = uid(), now = nowIso();
    await db.run(`INSERT INTO users (id,email,apple_sub,email_verified,created_at,updated_at) VALUES ($1,$2,$3,1,$4,$4)`, [uidv, id.email, id.sub, now]);
    u = (await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [uidv]))!;
  } else {
    if (u.role === 'admin') throw unauthorized('Connexion Apple non autorisée pour ce compte');
    await db.run(`UPDATE users SET apple_sub=$2, email_verified=1 WHERE id=$1`, [u.id, id.sub]);
  }
  if (u.status !== 'active') throw forbidden('Compte suspendu ou révoqué. Contactez le support.', 'account_disabled');
  await logLogin(db, { userId: u.id, email: u.email, ip: req.ip, ua: req.ua, success: true, reason: 'apple' });
  const s = await createSession(db, u.id, req);
  await checkAndRecordDevice(db, { id: u.id, email: u.email }, req.ip, req.ua, req.deviceHash);
  return { token: s.token, expiresAt: s.expiresAt, user: publicUser({ ...u, email_verified: 1 }) };
}

// ----------------------------------------------------------------------------- connexion par code reçu par email (sans mot de passe)
/** Envoie un code à 6 chiffres. Réponse identique que le compte existe ou non (pas d'énumération d'emails). */
export async function requestLoginCode(db: Db, req: Req, emailIn: unknown) {
  let email: string;
  try { email = normalizeEmail(emailIn); } catch { return; }
  const rl = hit(`logincode:${req.ip}`, 10, 3_600_000);
  if (!rl.allowed) return;
  let u = await db.get<{ id: string; role: string; status: string }>(`SELECT id, role, status FROM users WHERE email=$1`, [email]);
  if (u && (u.role === 'admin' || u.status !== 'active')) return; // l'administration a sa propre connexion renforcée
  if (!u) {
    // Création de compte sans mot de passe : mêmes plafonds d'inscription que le formulaire classique.
    const su = hit(`signup:${req.ip}`, config.signupPerIpPerHour, 3_600_000);
    if (!su.allowed) { await logEvent(db, 'signup_rate_limited', 'low', { ip: req.ip }); return; }
    const burst = hit(`burst:${req.ip}`, 1_000_000, 15 * 60_000).count >= config.signupBurstThreshold;
    const id = uid(), now = nowIso();
    await db.run(`INSERT INTO users (id,email,extra_verification,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)`, [id, email, burst ? 1 : 0, now]);
    if (burst) {
      await logEvent(db, 'signup_burst', 'medium', { ip: req.ip, userId: id });
      await db.run(`INSERT INTO fraud_reports (id,user_id,source,reason,created_at) VALUES ($1,$2,'auto',$3,$4)`, [uid(), id, 'Rafale d\'inscriptions depuis une même source (vérification supplémentaire requise, revue humaine)', now]);
    }
    u = { id, role: 'user', status: 'active' };
  }
  const code = await issueOtp(db, u.id, 'login_code', email);
  await notifyEmail(db, email, 'Votre code de connexion Velyra AI', `Votre code de connexion : ${code}\nIl expire dans ${config.otpTtlMinutes} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`, { sensitive: true });
}

export async function loginWithCode(db: Db, req: Req, emailIn: unknown, code: unknown) {
  let email: string;
  try { email = normalizeEmail(emailIn); } catch { throw unauthorized('Code incorrect'); }
  const rl = hit(`logincodeverify:${req.ip}`, 20, 600_000);
  if (!rl.allowed) { await recordFailedLogin(db, req.ip, null, 'login_code_rate_limited'); throw new HttpError(429, 'rate_limited', 'Trop de tentatives. Réessayez plus tard.'); }
  const u = await db.get<UserRow>(`SELECT ${USER_COLS} FROM users WHERE email=$1`, [email]);
  const fail = async () => { await logLogin(db, { userId: u?.id, email, ip: req.ip, ua: req.ua, success: false, reason: 'login_code_invalid' }); await recordFailedLogin(db, req.ip, u?.id ?? null, 'login_code_invalid'); throw unauthorized('Code incorrect ou expiré'); };
  if (!u || u.role === 'admin') return fail();
  try { await verifyOtp(db, u.id, 'login_code', String(code ?? '')); } catch (e) { if (e instanceof HttpError) return fail(); throw e; }
  if (u.status !== 'active') throw forbidden('Compte suspendu ou révoqué. Contactez le support.', 'account_disabled');
  await db.run(`UPDATE users SET email_verified=1 WHERE id=$1`, [u.id]); // recevoir le code prouve la possession de l'adresse
  await logLogin(db, { userId: u.id, email, ip: req.ip, ua: req.ua, success: true, reason: 'email_code' });
  const s = await createSession(db, u.id, req);
  await checkAndRecordDevice(db, { id: u.id, email: u.email }, req.ip, req.ua, req.deviceHash);
  return { token: s.token, expiresAt: s.expiresAt, user: publicUser({ ...u, email_verified: 1 }) };
}

// ----------------------------------------------------------------------------- mot de passe oublié
export async function requestPasswordReset(db: Db, req: Req, emailIn: unknown) {
  let email: string;
  try { email = normalizeEmail(emailIn); } catch { return; }
  const rl = hit(`reset:${req.ip}`, 10, 3_600_000);
  if (!rl.allowed) return;
  const u = await db.get<{ id: string; role: string }>(`SELECT id, role FROM users WHERE email=$1`, [email]);
  if (!u || u.role === 'admin') return; // réponse identique dans tous les cas (pas d'énumération)
  const code = await issueOtp(db, u.id, 'password_reset', email);
  await notifyEmail(db, email, 'Réinitialisation de votre mot de passe Velyra AI', `Code de réinitialisation : ${code}\nIl expire dans ${config.otpTtlMinutes} minutes.`, { sensitive: true });
}
export async function resetPassword(db: Db, req: Req, b: { email: unknown; code: unknown; newPassword: unknown }) {
  const email = normalizeEmail(b.email);
  const u = await db.get<{ id: string; role: string }>(`SELECT id, role FROM users WHERE email=$1`, [email]);
  if (!u || u.role === 'admin') throw bad('otp_invalid', 'Code incorrect');
  const pw = String(b.newPassword ?? '');
  const problems = userPasswordProblems(pw);
  if (problems.length) throw bad('weak_password', `Mot de passe trop faible : ${problems.join(', ')}`);
  await verifyOtp(db, u.id, 'password_reset', String(b.code ?? ''));
  await db.run(`UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=$3 WHERE id=$1`, [u.id, await hashPassword(pw), nowIso()]);
  await revokeAllSessions(db, u.id);
  await logEvent(db, 'password_reset', 'info', { ip: req.ip, userId: u.id });
}

// ----------------------------------------------------------------------------- téléphone (SMS)
export async function sendPhoneCode(db: Db, user: UserRow, phoneIn: unknown) {
  const phone = normalizePhone(phoneIn);
  const used = await db.get<{ id: string }>(`SELECT id FROM users WHERE phone=$1 AND phone_verified=1 AND id <> $2`, [phone, user.id]);
  if (used) throw conflict('phone_in_use', 'Ce numéro est déjà associé à un autre compte (un compte par numéro vérifié).');
  const code = await issueOtp(db, user.id, 'phone_verify', phone);
  await db.run(`UPDATE users SET phone=$2, phone_verified=0, updated_at=$3 WHERE id=$1`, [user.id, phone, nowIso()]);
  await notifySms(db, phone, `Velyra AI : votre code de vérification est ${code} (valable ${config.otpTtlMinutes} min).`, { sensitive: true });
}
export async function verifyPhoneCode(db: Db, user: UserRow, code: unknown) {
  const { target } = await verifyOtp(db, user.id, 'phone_verify', String(code ?? ''));
  try {
    await db.run(`UPDATE users SET phone=$2, phone_verified=1, updated_at=$3 WHERE id=$1`, [user.id, target, nowIso()]);
  } catch {
    // L'index unique (numéro vérifié) a refusé : un autre compte l'a vérifié entre-temps.
    throw conflict('phone_in_use', 'Ce numéro est déjà associé à un autre compte.');
  }
}

// ----------------------------------------------------------------------------- suppression de compte (RGPD)
export async function requestAccountDeletionCode(db: Db, user: UserRow) {
  const code = await issueOtp(db, user.id, 'delete_account', user.email);
  await notifyEmail(db, user.email, 'Confirmer la suppression de votre compte Velyra AI', `Code de confirmation : ${code}`, { sensitive: true });
}

/** Supprime le compte et ses données personnelles. Les écritures comptables (paiements) sont conservées sans lien avec la personne. */
export async function deleteAccount(db: Db, user: UserRow, b: { password?: unknown; code?: unknown }) {
  if (user.role === 'admin') throw forbidden('Un compte administrateur ne peut pas être supprimé ici');
  const row = await db.get<{ password_hash: string | null }>(`SELECT password_hash FROM users WHERE id=$1`, [user.id]);
  if (row?.password_hash) {
    if (!(await verifyPassword(String(b.password ?? ''), row.password_hash))) throw unauthorized('Mot de passe incorrect');
  } else {
    await verifyOtp(db, user.id, 'delete_account', String(b.code ?? ''));
  }
  await db.tx(async (t) => {
    const accs = await t.query<{ id: string }>(`SELECT id FROM tiktok_accounts WHERE user_id=$1`, [user.id]);
    for (const a of accs) {
      await t.run(`DELETE FROM tiktok_posts WHERE account_id=$1`, [a.id]);
      await t.run(`DELETE FROM tiktok_snapshots WHERE account_id=$1`, [a.id]);
    }
    const convs = await t.query<{ id: string }>(`SELECT id FROM conversations WHERE user_id=$1`, [user.id]);
    for (const c of convs) await t.run(`DELETE FROM messages WHERE conversation_id=$1`, [c.id]);
    await t.run(`DELETE FROM marketplace_listings WHERE owner_id=$1`, [user.id]);
    for (const tbl of ['tiktok_accounts', 'tasks', 'sessions', 'otp_codes', 'known_devices', 'login_challenges', 'login_logs', 'fraud_reports', 'subscriptions',
      'conversations', 'memories', 'documents', 'doc_chunks', 'agents', 'workflows', 'workflow_runs', 'api_keys'])
      await t.run(`DELETE FROM ${tbl} WHERE user_id=$1`, [user.id]);
    await t.run(`UPDATE payments SET user_id=NULL WHERE user_id=$1`, [user.id]);
    await t.run(`UPDATE security_events SET user_id=NULL WHERE user_id=$1`, [user.id]); // le hash chaîné couvre user_id : voir note README
    await t.run(`DELETE FROM users WHERE id=$1`, [user.id]);
  });
}

export type { HttpError };
export const _ipPrefix = ipPrefix;
