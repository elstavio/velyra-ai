import { api } from './api';

/** Utilitaires passkeys/WebAuthn côté navigateur (admin uniquement) — zero dépendance, API native navigator.credentials. */

export function webauthnSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

function b64uToBuf(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function bufToB64u(b: ArrayBuffer): string {
  let bin = '';
  const bytes = new Uint8Array(b);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Enregistre une nouvelle clé de sécurité sur le compte admin déjà authentifié (session en cours). */
export async function registerPasskey(name: string): Promise<{ id: string }> {
  const opt = await api<any>('/api/admin/webauthn/register/options', { admin: true, body: {} });
  const pk = opt.publicKey;
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...pk,
      challenge: b64uToBuf(pk.challenge),
      user: { ...pk.user, id: b64uToBuf(pk.user.id) },
      excludeCredentials: (pk.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
    },
  })) as PublicKeyCredential;
  const resp = cred.response as AuthenticatorAttestationResponse;
  return api('/api/admin/webauthn/register/verify', {
    admin: true,
    body: {
      challengeId: opt.challengeId, name,
      credential: { id: bufToB64u(cred.rawId), response: { attestationObject: bufToB64u(resp.attestationObject), clientDataJSON: bufToB64u(resp.clientDataJSON) } },
    },
  });
}

/** Authentification par clé de sécurité au cours d'une cérémonie de connexion admin (remplace le code TOTP). */
export async function authenticatePasskey(loginChallengeId: string): Promise<any> {
  const opt = await api<any>('/api/admin/auth/webauthn/options', { body: { challengeId: loginChallengeId } });
  const pk = opt.publicKey;
  const cred = (await navigator.credentials.get({
    publicKey: { ...pk, challenge: b64uToBuf(pk.challenge), allowCredentials: (pk.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })) },
  })) as PublicKeyCredential;
  const resp = cred.response as AuthenticatorAssertionResponse;
  return api('/api/admin/auth/webauthn/verify', {
    body: {
      challengeId: loginChallengeId,
      credential: { id: bufToB64u(cred.rawId), response: { authenticatorData: bufToB64u(resp.authenticatorData), clientDataJSON: bufToB64u(resp.clientDataJSON), signature: bufToB64u(resp.signature) } },
    },
  });
}
