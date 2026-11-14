import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

// --- Petit encodeur CBOR (le strict nécessaire pour émuler ce que produit un authentificateur réel). ---
function cborBytes(b: Buffer): Buffer {
  const n = b.length;
  if (n < 24) return Buffer.concat([Buffer.from([0x40 | n]), b]);
  if (n < 256) return Buffer.concat([Buffer.from([0x58, n]), b]);
  const len = Buffer.alloc(2); len.writeUInt16BE(n, 0);
  return Buffer.concat([Buffer.from([0x59]), len, b]);
}
function cborText(s: string): Buffer {
  const b = Buffer.from(s, 'utf8'); const n = b.length;
  if (n < 24) return Buffer.concat([Buffer.from([0x60 | n]), b]);
  return Buffer.concat([Buffer.from([0x78, n]), b]);
}
function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x18, n]);
  throw new Error('non géré dans ce test');
}
function cborNegInt(n: number): Buffer {
  // encode -1-n pour n >= 0 (n ici est la valeur positive de |x|-1 déjà calculée par l'appelant)
  if (n < 24) return Buffer.from([0x20 | n]);
  if (n < 256) return Buffer.from([0x38, n]);
  throw new Error('non géré dans ce test');
}
/** Table COSE_Key EC2 : {1: 2 (kty EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} */
function coseKeyEc2(x: Buffer, y: Buffer): Buffer {
  const entries = Buffer.concat([
    cborUint(1), cborUint(2), // kty: EC2
    cborUint(3), cborNegInt(6), // alg: -7  (-1-6 = -7)
    cborNegInt(0), cborUint(1), // crv: 1 (P-256)  key -1 = -1-0
    cborNegInt(1), cborBytes(x), // x : key -2 = -1-1
    cborNegInt(2), cborBytes(y), // y : key -3 = -1-2
  ]);
  return Buffer.concat([Buffer.from([0xa5]), entries]); // map, 5 paires
}
function cborMapFmtAuthDataAttStmt(authData: Buffer): Buffer {
  const entries = Buffer.concat([
    cborText('fmt'), cborText('none'),
    cborText('authData'), cborBytes(authData),
    cborText('attStmt'), Buffer.from([0xa0]), // map vide
  ]);
  return Buffer.concat([Buffer.from([0xa3]), entries]); // map, 3 paires
}

function sha256(b: Buffer) { return createHash('sha256').update(b).digest(); }
const b64u = (b: Buffer) => b.toString('base64url');

function makeAuthData(rpId: string, flags: number, signCount: number, credIdAndKey?: { credId: Buffer; x: Buffer; y: Buffer }) {
  const rpIdHash = sha256(Buffer.from(rpId, 'utf8'));
  const flagsByte = Buffer.from([flags]);
  const count = Buffer.alloc(4); count.writeUInt32BE(signCount, 0);
  let rest = Buffer.alloc(0);
  if (credIdAndKey) {
    const aaguid = Buffer.alloc(16);
    const credIdLen = Buffer.alloc(2); credIdLen.writeUInt16BE(credIdAndKey.credId.length, 0);
    const coseKey = coseKeyEc2(credIdAndKey.x, credIdAndKey.y);
    rest = Buffer.concat([aaguid, credIdLen, credIdAndKey.credId, coseKey]);
  }
  return Buffer.concat([rpIdHash, flagsByte, count, rest]);
}

function genKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk: any = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  return { publicKey, privateKey, x, y };
}

test('passkey/WebAuthn admin : enregistrement puis authentification réelle (ECDSA P-256) remplacent le code TOTP', async () => {
  const a = await t.admin(); // connexion normale (mot de passe + TOTP) pour obtenir une session admin
  const rpId = 'localhost'; // dérivé d'APP_URL=http://localhost:3999 dans les tests
  const origin = 'http://localhost:3999';
  const { publicKey, privateKey, x, y } = genKeypair();
  const credId = Buffer.from('cred-id-0123456789abcdef', 'utf8');

  // --- Enregistrement ---
  const opt = await t.call('POST', '/api/admin/webauthn/register/options', { token: a.token, ip: a.ip });
  assert.equal(opt.status, 200);
  const challengeId = opt.body.challengeId as string;
  const challenge = opt.body.publicKey.challenge as string;
  assert.equal(opt.body.publicKey.rp.id, rpId);

  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }), 'utf8');
  const authData = makeAuthData(rpId, 0x45 /* UP|UV|AT */, 0, { credId, x, y });
  const attestationObject = cborMapFmtAuthDataAttStmt(authData);

  const reg = await t.call('POST', '/api/admin/webauthn/register/verify', {
    token: a.token, ip: a.ip,
    body: { challengeId, name: 'Clé de test', credential: { id: b64u(credId), response: { attestationObject: b64u(attestationObject), clientDataJSON: b64u(clientDataJSON) } } },
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));

  const list = await t.call('GET', '/api/admin/webauthn/credentials', { token: a.token, ip: a.ip });
  assert.equal(list.status, 200);
  assert.equal(list.body.credentials.length, 1);
  assert.equal(list.body.credentials[0].name, 'Clé de test');

  // --- Authentification par clé de sécurité, sur un appareil déjà connu pour éviter l'étape email_otp ---
  const login = await t.call('POST', '/api/admin/auth/login', { body: { email: 'owner@test.invalid', password: 'Correct-Horse-Battery-42!' }, device: a.device, ip: a.ip });
  assert.equal(login.status, 200);
  assert.equal(login.body.hasWebauthn, true);
  const loginChallengeId = login.body.challengeId as string;

  const authOpt = await t.call('POST', '/api/admin/auth/webauthn/options', { body: { challengeId: loginChallengeId }, device: a.device, ip: a.ip });
  assert.equal(authOpt.status, 200, JSON.stringify(authOpt.body));
  const authChallenge = authOpt.body.publicKey.challenge as string;
  assert.equal(authOpt.body.publicKey.allowCredentials[0].id, b64u(credId));

  const assertClientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authChallenge, origin }), 'utf8');
  const assertAuthData = makeAuthData(rpId, 0x05 /* UP|UV */, 1);
  const signedData = Buffer.concat([assertAuthData, sha256(assertClientDataJSON)]);
  const signature = cryptoSign('sha256', signedData, { key: privateKey, dsaEncoding: 'der' });

  const verify = await t.call('POST', '/api/admin/auth/webauthn/verify', {
    device: a.device, ip: a.ip,
    body: { challengeId: loginChallengeId, credential: { id: b64u(credId), response: { authenticatorData: b64u(assertAuthData), clientDataJSON: b64u(assertClientDataJSON), signature: b64u(signature) } } },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.done, true);
  assert.ok(verify.body.token);

  const row = await t.db.get<any>(`SELECT sign_count FROM webauthn_credentials WHERE credential_id=$1`, [b64u(credId)]);
  assert.equal(row.sign_count, 1);

  // --- Rejoue la même assertion (compteur de signatures non croissant) : doit être refusée (détection de clonage) ---
  const l2 = await t.call('POST', '/api/admin/auth/login', { body: { email: 'owner@test.invalid', password: 'Correct-Horse-Battery-42!' }, device: a.device, ip: a.ip });
  assert.equal(l2.status, 200);
  const loginChallengeId2 = l2.body.challengeId as string;
  const authOpt2 = await t.call('POST', '/api/admin/auth/webauthn/options', { body: { challengeId: loginChallengeId2 }, device: a.device, ip: a.ip });
  assert.equal(authOpt2.status, 200);
  const authChallenge2 = authOpt2.body.publicKey.challenge as string;
  const clientDataJSON2 = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authChallenge2, origin }), 'utf8');
  // Même compteur (1) que lors de la connexion précédente déjà acceptée : le serveur doit détecter le rejeu/clonage.
  const authData2 = makeAuthData(rpId, 0x05, 1);
  const signedData2 = Buffer.concat([authData2, sha256(clientDataJSON2)]);
  const signature2 = cryptoSign('sha256', signedData2, { key: privateKey, dsaEncoding: 'der' });
  const replayVerify = await t.call('POST', '/api/admin/auth/webauthn/verify', {
    device: a.device, ip: a.ip,
    body: { challengeId: loginChallengeId2, credential: { id: b64u(credId), response: { authenticatorData: b64u(authData2), clientDataJSON: b64u(clientDataJSON2), signature: b64u(signature2) } } },
  });
  assert.equal(replayVerify.status, 400);

  void publicKey; void createPrivateKey; void createPublicKey;
});

test('passkey/WebAuthn : une credential_id inconnue du compte est rejetée (jamais acceptée comme second facteur)', async () => {
  const a = await t.admin('dev-admin-0123456789abcdef', '198.51.100.9');
  const login = await t.call('POST', '/api/admin/auth/login', { body: { email: 'owner@test.invalid', password: 'Correct-Horse-Battery-42!' }, device: a.device, ip: a.ip });
  assert.equal(login.status, 200);
  const loginChallengeId = login.body.challengeId as string;
  const optRes = await t.call('POST', '/api/admin/auth/webauthn/options', { body: { challengeId: loginChallengeId }, device: a.device, ip: a.ip });
  assert.equal(optRes.status, 200);
  const verify = await t.call('POST', '/api/admin/auth/webauthn/verify', {
    device: a.device, ip: a.ip,
    body: { challengeId: loginChallengeId, credential: { id: Buffer.from('credential-jamais-enregistree').toString('base64url'), response: { authenticatorData: '', clientDataJSON: '', signature: '' } } },
  });
  assert.equal(verify.status, 400);
  assert.equal(verify.body.error.code, 'credential_unknown');
});

test('passkey/WebAuthn : après suppression de la clé, la connexion ne la propose plus (no_passkey)', async () => {
  const a = await t.admin('dev-admin-0123456789abcdef', '198.51.100.9');
  const list = await t.call('GET', '/api/admin/webauthn/credentials', { token: a.token, ip: a.ip });
  assert.equal(list.body.credentials.length, 1);
  const del = await t.call('DELETE', `/api/admin/webauthn/credentials/${list.body.credentials[0].id}`, { token: a.token, ip: a.ip });
  assert.equal(del.status, 200);

  const login = await t.call('POST', '/api/admin/auth/login', { body: { email: 'owner@test.invalid', password: 'Correct-Horse-Battery-42!' }, device: a.device, ip: a.ip });
  assert.equal(login.status, 200);
  assert.equal(login.body.hasWebauthn, false);
  const optRes = await t.call('POST', '/api/admin/auth/webauthn/options', { body: { challengeId: login.body.challengeId }, device: a.device, ip: a.ip });
  assert.equal(optRes.status, 404);
  assert.equal(optRes.body.error.code, 'no_passkey');
});
