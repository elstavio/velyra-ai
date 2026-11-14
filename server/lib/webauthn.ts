/**
 * WebAuthn (passkeys / FIDO2) côté serveur — zero dépendance (CBOR maison, vérification de signature via
 * node:crypto). Portée volontairement restreinte à ce dont un assistant d'administration a besoin :
 *  - algorithme ES256 (ECDSA P-256 / SHA-256) uniquement — c'est l'algorithme par défaut de Face ID, Touch ID,
 *    Windows Hello, Android et des clés de sécurité matérielles (YubiKey…) ;
 *  - attestation « none » uniquement — on ne vérifie pas la chaîne de certificats du fabricant de
 *    l'authentificateur (« attestation »), seulement que la clé publique fournie est valide et que le
 *    porteur en détient bien la clé privée. C'est le choix recommandé pour une partie de confiance (RP) de
 *    première main qui ne gère pas de parc d'appareils : il simplifie l'implémentation sans affaiblir la
 *    garantie qui compte réellement ici (possession de la clé privée, résistance au phishing par liaison à
 *    l'origine). Une demande d'attestation « direct »/« indirect » ou un autre algorithme est refusée
 *    explicitement plutôt que silencieusement mal interprétée.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { cborDecode, cborDecodeWithOffset } from './cbor.js';

export interface ParsedAttestation {
  credentialId: string; // base64url
  publicKeyX: string; // base64url
  publicKeyY: string; // base64url
  signCount: number;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

function parseClientData(clientDataJSON: Buffer, expectedType: 'webauthn.create' | 'webauthn.get', expectedChallenge: string, expectedOrigin: string) {
  let cd: any;
  try { cd = JSON.parse(clientDataJSON.toString('utf8')); } catch { throw new Error('clientDataJSON invalide'); }
  if (cd.type !== expectedType) throw new Error(`Type inattendu : ${cd.type}`);
  if (cd.challenge !== expectedChallenge) throw new Error('Challenge invalide (rejeu ou cérémonie expirée)');
  if (cd.origin !== expectedOrigin) throw new Error(`Origine inattendue : ${cd.origin}`);
  return cd;
}

/** Analyse authenticatorData (RFC WebAuthn §6.1) ; retourne les champs communs + les données de credential si présentes (flag AT). */
function parseAuthData(authData: Buffer, expectedRpIdHash: Buffer) {
  if (authData.length < 37) throw new Error('authenticatorData trop court');
  const rpIdHash = authData.subarray(0, 32);
  if (!rpIdHash.equals(expectedRpIdHash)) throw new Error('rpIdHash invalide (origine/RP ID incorrect)');
  const flags = authData[32];
  const userPresent = !!(flags & 0x01), userVerified = !!(flags & 0x04), attestedCredentialData = !!(flags & 0x40);
  const signCount = authData.readUInt32BE(33);
  let rest = authData.subarray(37);
  let cred: { credentialId: Buffer; publicKeyX: Buffer; publicKeyY: Buffer } | null = null;
  if (attestedCredentialData) {
    // aaguid(16) + credIdLen(2) + credId(credIdLen) + credentialPublicKey (CBOR, COSE_Key)
    const credIdLen = rest.readUInt16BE(16);
    const credentialId = rest.subarray(18, 18 + credIdLen);
    const { value: coseKey, offset } = cborDecodeWithOffset(Buffer.from(rest.subarray(18 + credIdLen)));
    void offset;
    const map = coseKey as Map<unknown, unknown>;
    const kty = map.get(1), alg = map.get(3), crv = map.get(-1), x = map.get(-2), y = map.get(-3);
    if (kty !== 2) throw new Error('Type de clé COSE non pris en charge (EC2 attendu)');
    if (alg !== -7) throw new Error('Algorithme non pris en charge (ES256/-7 requis)');
    if (crv !== 1) throw new Error('Courbe non prise en charge (P-256 requise)');
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('Clé publique COSE invalide');
    cred = { credentialId: Buffer.from(credentialId), publicKeyX: x, publicKeyY: y };
    rest = rest.subarray(18 + credIdLen + offset);
  }
  return { userPresent, userVerified, signCount, cred };
}

/** Cérémonie d'enregistrement (navigator.credentials.create). fmt 'none' uniquement (voir note de module). */
export function verifyRegistration(o: {
  attestationObjectB64: string; clientDataJSONB64: string; expectedChallenge: string; expectedOrigin: string; rpId: string;
}): ParsedAttestation {
  const clientDataJSON = fromB64u(o.clientDataJSONB64);
  parseClientData(clientDataJSON, 'webauthn.create', o.expectedChallenge, o.expectedOrigin);
  const att = cborDecode(fromB64u(o.attestationObjectB64)) as Map<unknown, unknown>;
  const fmt = att.get('fmt');
  if (fmt !== 'none') throw new Error(`Format d'attestation non pris en charge : ${fmt} (seul « none » est accepté)`);
  const authData = att.get('authData') as Buffer;
  const { userPresent, userVerified, signCount, cred } = parseAuthData(authData, sha256(Buffer.from(o.rpId, 'utf8')));
  if (!userPresent) throw new Error('Présence utilisateur non confirmée par l\'authentificateur');
  if (!userVerified) throw new Error('Vérification de l\'utilisateur (biométrie/code) non confirmée');
  if (!cred) throw new Error('Aucune clé publique de credential dans authenticatorData');
  return { credentialId: b64u(cred.credentialId), publicKeyX: b64u(cred.publicKeyX), publicKeyY: b64u(cred.publicKeyY), signCount };
}

/** Cérémonie d'authentification (navigator.credentials.get). Retourne le compteur de signatures mis à jour. */
export function verifyAssertion(o: {
  authenticatorDataB64: string; clientDataJSONB64: string; signatureB64: string;
  expectedChallenge: string; expectedOrigin: string; rpId: string;
  publicKeyX: string; publicKeyY: string; previousSignCount: number;
}): { signCount: number } {
  const clientDataJSON = fromB64u(o.clientDataJSONB64);
  parseClientData(clientDataJSON, 'webauthn.get', o.expectedChallenge, o.expectedOrigin);
  const authData = fromB64u(o.authenticatorDataB64);
  const { userPresent, userVerified, signCount } = parseAuthData(authData, sha256(Buffer.from(o.rpId, 'utf8')));
  if (!userPresent) throw new Error('Présence utilisateur non confirmée par l\'authentificateur');
  if (!userVerified) throw new Error('Vérification de l\'utilisateur (biométrie/code) non confirmée');
  // Le compteur de signatures doit strictement progresser (sauf 0 persistant, cas connu de certains authentificateurs
  // de plateforme comme Touch ID/Face ID qui ne l'incrémentent jamais) — détecte un clonage de clé.
  if (!(signCount === 0 && o.previousSignCount === 0) && signCount <= o.previousSignCount) {
    throw new Error('Compteur de signatures non croissant : possible clonage de la clé de sécurité');
  }
  const pub = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: o.publicKeyX, y: o.publicKeyY } as any });
  const signedData = Buffer.concat([authData, sha256(clientDataJSON)]);
  const ok = cryptoVerify('sha256', signedData, { key: pub, dsaEncoding: 'der' } as any, fromB64u(o.signatureB64));
  if (!ok) throw new Error('Signature invalide');
  return { signCount };
}

export { b64u, fromB64u };
