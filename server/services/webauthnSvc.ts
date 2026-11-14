import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { verifyAssertion, verifyRegistration } from '../lib/webauthn.js';
import type { Req } from '../lib/http.js';
import { HttpError, addMinutes, bad, nowIso, parseJson, uid, unauthorized } from '../lib/util.js';
import { logEvent, recordSecuritySignal } from './security.js';
import { loadChallenge, finishIfComplete } from './adminAuth.js';

/** Options d'enregistrement d'une nouvelle clé de sécurité (passkey) — appelé en session admin déjà authentifiée. */
export async function registerOptions(db: Db, user: { id: string; email: string }) {
  const challenge = randomToken(32);
  const id = uid();
  await db.run(`INSERT INTO webauthn_challenges (id,user_id,kind,challenge,expires_at,created_at) VALUES ($1,$2,'register',$3,$4,$5)`, [id, user.id, challenge, addMinutes(10), nowIso()]);
  const existing = await db.query<{ credential_id: string }>(`SELECT credential_id FROM webauthn_credentials WHERE user_id=$1`, [user.id]);
  return {
    challengeId: id,
    publicKey: {
      challenge,
      rp: { id: config.webauthnRpId, name: 'Velyra AI' },
      user: { id: Buffer.from(user.id).toString('base64url'), name: user.email, displayName: user.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60_000,
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id })),
    },
  };
}

export async function registerVerify(db: Db, user: { id: string }, challengeId: unknown, name: unknown, credential: any) {
  const wc = await db.get<any>(`SELECT * FROM webauthn_challenges WHERE id=$1 AND user_id=$2 AND kind='register'`, [String(challengeId ?? ''), user.id]);
  if (!wc) throw unauthorized('Cérémonie invalide : recommencez l\'enregistrement');
  if (wc.expires_at < nowIso()) { await db.run(`DELETE FROM webauthn_challenges WHERE id=$1`, [wc.id]); throw new HttpError(401, 'challenge_expired', 'Expiré : recommencez l\'enregistrement'); }
  let parsed;
  try {
    parsed = verifyRegistration({
      attestationObjectB64: String(credential?.response?.attestationObject ?? ''),
      clientDataJSONB64: String(credential?.response?.clientDataJSON ?? ''),
      expectedChallenge: wc.challenge, expectedOrigin: config.appUrl, rpId: config.webauthnRpId,
    });
  } catch (e) { throw bad('webauthn_invalid', `Enregistrement refusé : ${String((e as Error).message)}`); }
  const dup = await db.get(`SELECT id FROM webauthn_credentials WHERE credential_id=$1`, [parsed.credentialId]);
  if (dup) throw bad('already_registered', 'Cette clé est déjà enregistrée sur ce compte');
  const id = uid();
  await db.run(`INSERT INTO webauthn_credentials (id,user_id,credential_id,public_key_x,public_key_y,sign_count,name,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, user.id, parsed.credentialId, parsed.publicKeyX, parsed.publicKeyY, parsed.signCount, name ? String(name).slice(0, 100) : null, nowIso()]);
  await db.run(`DELETE FROM webauthn_challenges WHERE id=$1`, [wc.id]);
  await logEvent(db, 'admin_webauthn_registered', 'medium', { userId: user.id, detail: { name: name ?? null } });
  return { id };
}

export async function listCredentials(db: Db, userId: string) {
  return db.query<any>(`SELECT id,name,created_at,last_used_at FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
}
export async function deleteCredential(db: Db, userId: string, id: string) {
  const r = await db.run(`DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Clé introuvable');
}

/** Options d'authentification par clé de sécurité, dans le cadre d'une cérémonie de connexion admin en cours (challengeId = login_challenges.id). */
export async function authOptions(db: Db, loginChallengeId: unknown) {
  const c = await loadChallenge(db, loginChallengeId);
  const creds = await db.query<{ credential_id: string }>(`SELECT credential_id FROM webauthn_credentials WHERE user_id=$1`, [c.user_id]);
  if (!creds.length) throw new HttpError(404, 'no_passkey', 'Aucune clé de sécurité enregistrée pour ce compte');
  const challenge = randomToken(32);
  const id = uid();
  await db.run(`INSERT INTO webauthn_challenges (id,user_id,kind,challenge,login_challenge_id,expires_at,created_at) VALUES ($1,$2,'authenticate',$3,$4,$5,$6)`,
    [id, c.user_id, challenge, c.id, addMinutes(5), nowIso()]);
  return { publicKey: { challenge, rpId: config.webauthnRpId, allowCredentials: creds.map((x) => ({ type: 'public-key', id: x.credential_id })), userVerification: 'required', timeout: 60_000 } };
}

/** Vérifie l'assertion et, en cas de succès, satisfait l'étape « totp » de la cérémonie de connexion admin (une clé de sécurité est un second facteur au moins aussi fort qu'un code TOTP). */
export async function authVerify(db: Db, req: Req, loginChallengeId: unknown, credential: any) {
  const c = await loadChallenge(db, loginChallengeId);
  await db.run(`UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1`, [c.id]);
  const wc = await db.get<any>(`SELECT * FROM webauthn_challenges WHERE login_challenge_id=$1 AND kind='authenticate' ORDER BY created_at DESC LIMIT 1`, [c.id]);
  if (!wc || wc.expires_at < nowIso()) throw new HttpError(401, 'challenge_expired', 'Défi expiré : redemandez une authentification par clé de sécurité');
  const credId = String(credential?.id ?? '');
  const credRow = await db.get<any>(`SELECT * FROM webauthn_credentials WHERE credential_id=$1 AND user_id=$2`, [credId, c.user_id]);
  if (!credRow) { await logEvent(db, 'admin_webauthn_unknown_credential', 'medium', { ip: req.ip, userId: c.user_id }); await recordSecuritySignal(db, req.ip, 'webauthn_failed'); throw bad('credential_unknown', 'Clé de sécurité inconnue pour ce compte'); }
  let result;
  try {
    result = verifyAssertion({
      authenticatorDataB64: String(credential?.response?.authenticatorData ?? ''),
      clientDataJSONB64: String(credential?.response?.clientDataJSON ?? ''),
      signatureB64: String(credential?.response?.signature ?? ''),
      expectedChallenge: wc.challenge, expectedOrigin: config.appUrl, rpId: config.webauthnRpId,
      publicKeyX: credRow.public_key_x, publicKeyY: credRow.public_key_y, previousSignCount: credRow.sign_count,
    });
  } catch (e) {
    await logEvent(db, 'admin_webauthn_failed', 'high', { ip: req.ip, userId: c.user_id, detail: { error: String((e as Error).message) } });
    await recordSecuritySignal(db, req.ip, 'webauthn_failed');
    throw bad('webauthn_invalid', 'Authentification par clé de sécurité refusée');
  }
  await db.run(`UPDATE webauthn_credentials SET sign_count=$2, last_used_at=$3 WHERE id=$1`, [credRow.id, result.signCount, nowIso()]);
  await db.run(`DELETE FROM webauthn_challenges WHERE id=$1`, [wc.id]);
  const done = parseJson<string[]>(c.steps_done, []);
  done.push('totp'); // satisfait la même étape que le code TOTP
  await db.run(`UPDATE login_challenges SET steps_done=$2 WHERE id=$1`, [c.id, JSON.stringify(done)]);
  await logEvent(db, 'admin_webauthn_login', 'info', { ip: req.ip, userId: c.user_id });
  return finishIfComplete(db, req, c, done);
}
