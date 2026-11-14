import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { config } from '../config.js';

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let cache: { keys: Jwk[]; at: number } | null = null;

// Clés publiques Google (JWK) : https://www.googleapis.com/oauth2/v3/certs — à mettre en cache (doc Google « Verify the Google ID token »).
export let fetchGoogleJwks = async (): Promise<Jwk[]> => {
  if (cache && Date.now() - cache.at < 3_600_000) return cache.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('Clés Google indisponibles');
  const j = (await r.json()) as { keys: Jwk[] };
  cache = { keys: j.keys, at: Date.now() };
  return j.keys;
};
export const setJwksFetcher = (f: typeof fetchGoogleJwks) => { fetchGoogleJwks = f; };

const b64 = (s: string) => Buffer.from(s, 'base64url');

export interface GoogleIdentity { sub: string; email: string; emailVerified: boolean }

/** Vérifie signature RS256, `iss`, `aud` et `exp` d'un jeton d'identité Google. */
export async function verifyGoogleIdToken(idToken: string, now = Date.now()): Promise<GoogleIdentity> {
  if (!config.googleClientId) throw new Error('Connexion Google non configurée');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Jeton invalide');
  const header = JSON.parse(b64(parts[0]).toString());
  const claims = JSON.parse(b64(parts[1]).toString());
  if (header.alg !== 'RS256') throw new Error('Algorithme non accepté');
  const key = (await fetchGoogleJwks()).find((k) => k.kid === header.kid);
  if (!key) throw new Error('Clé inconnue');
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: key as any, format: 'jwk' }), b64(parts[2]));
  if (!ok) throw new Error('Signature invalide');
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') throw new Error('Émetteur invalide');
  if (claims.aud !== config.googleClientId) throw new Error('Audience invalide');
  if (!claims.exp || claims.exp * 1000 < now) throw new Error('Jeton expiré');
  if (!claims.sub || !claims.email) throw new Error('Jeton incomplet');
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), emailVerified: claims.email_verified === true || claims.email_verified === 'true' };
}

// ---------------------------------------------------------------------------------------------- Apple
// Sign in with Apple : émetteur https://appleid.apple.com, clés https://appleid.apple.com/auth/keys, signature RS256
// (openid-configuration d'Apple). L'audience est le « Services ID » (APPLE_CLIENT_ID).
let appleCache: { keys: Jwk[]; at: number } | null = null;
export let fetchAppleJwks = async (): Promise<Jwk[]> => {
  if (appleCache && Date.now() - appleCache.at < 3_600_000) return appleCache.keys;
  const r = await fetch('https://appleid.apple.com/auth/keys');
  if (!r.ok) throw new Error('Clés Apple indisponibles');
  const j = (await r.json()) as { keys: Jwk[] };
  appleCache = { keys: j.keys, at: Date.now() };
  return j.keys;
};
export const setAppleJwksFetcher = (f: typeof fetchAppleJwks) => { fetchAppleJwks = f; };

export interface AppleIdentity { sub: string; email: string; emailVerified: boolean }

/** Vérifie signature, émetteur, audience, expiration et nonce (le nonce envoyé par le navigateur, brut ou haché SHA-256). */
export async function verifyAppleIdToken(idToken: string, nonce: string, now = Date.now()): Promise<AppleIdentity> {
  if (!config.appleClientId) throw new Error('Connexion Apple non configurée');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Jeton invalide');
  const header = JSON.parse(b64(parts[0]).toString());
  const claims = JSON.parse(b64(parts[1]).toString());
  if (header.alg !== 'RS256') throw new Error('Algorithme non accepté');
  const key = (await fetchAppleJwks()).find((k) => k.kid === header.kid);
  if (!key) throw new Error('Clé inconnue');
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: key as any, format: 'jwk' }), b64(parts[2]));
  if (!ok) throw new Error('Signature invalide');
  if (claims.iss !== 'https://appleid.apple.com') throw new Error('Émetteur invalide');
  if (claims.aud !== config.appleClientId) throw new Error('Audience invalide');
  if (!claims.exp || claims.exp * 1000 < now) throw new Error('Jeton expiré');
  if (!nonce || (claims.nonce !== nonce && claims.nonce !== createHash('sha256').update(nonce).digest('hex'))) throw new Error('Nonce invalide');
  if (!claims.sub || !claims.email) throw new Error('Jeton incomplet (email non partagé)');
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), emailVerified: claims.email_verified === true || claims.email_verified === 'true' };
}
