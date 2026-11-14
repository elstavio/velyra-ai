import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

test('inscription → vérification email → connexion', async () => {
  const ip = t.newIp(), email = 'a1@test.invalid';
  let r = await t.call('POST', '/api/auth/register', { body: { email, password: 'Motdepasse123', country: 'CI' }, ip });
  assert.equal(r.status, 200);
  r = await t.call('POST', '/api/auth/register', { body: { email, password: 'Motdepasse123' }, ip });
  assert.equal(r.status, 409);
  r = await t.call('POST', '/api/auth/register', { body: { email: 'b@test.invalid', password: 'court' }, ip });
  assert.equal(r.body.error.code, 'weak_password');
  r = await t.call('POST', '/api/auth/login', { body: { email, password: 'Motdepasse123' }, ip });
  assert.equal(r.status, 200);
  const token = r.body.token;
  let me = await t.call('GET', '/api/me', { token, ip });
  assert.equal(me.body.user.emailVerified, false);
  assert.ok(me.body.todo.includes('verify_email'));
  r = await t.call('POST', '/api/auth/verify-email', { body: { code: '000000' }, token, ip });
  assert.equal(r.body.error.code, 'otp_invalid');
  r = await t.call('POST', '/api/auth/verify-email', { body: { code: t.lastCode(email) }, token, ip });
  assert.equal(r.status, 200);
  me = await t.call('GET', '/api/me', { token, ip });
  assert.equal(me.body.user.emailVerified, true);
  // un code ne sert qu'une fois
  r = await t.call('POST', '/api/auth/verify-email', { body: { code: t.lastCode(email) }, token, ip });
  assert.equal(r.status, 400);
});

test('le code OTP n\'est jamais conservé en base (journal de notifications expurgé)', async () => {
  const u = await t.user({ phone: false });
  const rows = await t.db.query<any>(`SELECT body FROM notifications WHERE recipient=$1`, [u.email]);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!/\d{6}/.test(r.body));
});

test('OTP : 5 essais maximum par code', async () => {
  const ip = t.newIp(), email = 'otp@test.invalid';
  await t.call('POST', '/api/auth/register', { body: { email, password: 'Motdepasse123' }, ip });
  const token = (await t.call('POST', '/api/auth/login', { body: { email, password: 'Motdepasse123' }, ip })).body.token;
  const good = t.lastCode(email);
  const wrong = good === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/api/auth/verify-email', { body: { code: wrong }, token, ip })).body.error.code, 'otp_invalid');
  assert.equal((await t.call('POST', '/api/auth/verify-email', { body: { code: good }, token, ip })).body.error.code, 'otp_locked');
});

test('mauvais mot de passe : message neutre, journal, verrouillage du compte', async () => {
  const u = await t.user({ phone: false });
  const ip = t.newIp();
  let r = await t.call('POST', '/api/auth/login', { body: { email: u.email, password: 'faux' }, ip });
  assert.equal(r.status, 401);
  const r2 = await t.call('POST', '/api/auth/login', { body: { email: 'inconnu@test.invalid', password: 'faux' }, ip });
  assert.equal(r2.body.error.message, r.body.error.message); // pas d'énumération de comptes
  for (let i = 0; i < 8; i++) r = await t.call('POST', '/api/auth/login', { body: { email: u.email, password: 'faux' }, ip });
  r = await t.call('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, ip });
  assert.equal(r.status, 423);
  const logs = await t.db.query<any>(`SELECT success FROM login_logs WHERE email=$1`, [u.email]);
  assert.ok(logs.some((l) => l.success === 0));
});

test('un numéro de téléphone vérifié ne peut servir qu\'à un seul compte (§2)', async () => {
  const phone = '+2250700112233';
  await t.user({ phone });
  const second = await t.user({ phone: false });
  const r = await t.call('POST', '/api/account/phone/send', { body: { phone }, token: second.token, ip: second.ip });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'phone_in_use');
});

test('sessions actives : liste et déconnexion à distance (§1)', async () => {
  const u = await t.user({ phone: false });
  const s2 = (await t.call('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, ip: t.newIp() })).body.token;
  const list = await t.call('GET', '/api/account/sessions', { token: u.token, ip: u.ip });
  assert.equal(list.body.sessions.length, 2);
  const other = list.body.sessions.find((s: any) => !s.current);
  assert.equal((await t.call('DELETE', `/api/account/sessions/${other.id}`, { token: u.token, ip: u.ip })).status, 200);
  assert.equal((await t.call('GET', '/api/me', { token: s2, ip: u.ip })).status, 401);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).status, 200);
});

test('mot de passe oublié : réponse identique, code à usage unique, sessions révoquées', async () => {
  const u = await t.user({ phone: false });
  const ip = t.newIp();
  const a = await t.call('POST', '/api/auth/forgot', { body: { email: u.email }, ip });
  const b = await t.call('POST', '/api/auth/forgot', { body: { email: 'nobody@test.invalid' }, ip });
  assert.deepEqual(a.body, b.body);
  const code = t.lastCode(u.email);
  const r = await t.call('POST', '/api/auth/reset', { body: { email: u.email, code, newPassword: 'NouveauMdp456' }, ip });
  assert.equal(r.status, 200);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: u.email, password: 'NouveauMdp456' }, ip })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/reset', { body: { email: u.email, code, newPassword: 'AutreMdp789' }, ip })).status, 400);
});

test('limitation de débit des inscriptions par IP + vérification supplémentaire en rafale (jamais de blocage VPN)', async () => {
  const ip = '192.0.2.50';
  const results: number[] = [];
  for (let i = 0; i < 7; i++) results.push((await t.call('POST', '/api/auth/register', { body: { email: `burst${i}@test.invalid`, password: 'Motdepasse123' }, ip })).status);
  assert.deepEqual(results, [200, 200, 200, 200, 200, 200, 200]); // sous le plafond horaire : aucun blocage
  const flagged = await t.db.query<any>(`SELECT email FROM users WHERE extra_verification=1 AND email LIKE 'burst%'`);
  assert.ok(flagged.length >= 2, 'les inscriptions de la rafale sont marquées pour vérification supplémentaire');
  const reports = await t.db.query<any>(`SELECT source,status FROM fraud_reports WHERE source='auto'`);
  assert.ok(reports.every((r) => r.status === 'open'), 'revue humaine : aucune suspension automatique');
  const users = await t.db.query<any>(`SELECT status FROM users WHERE email LIKE 'burst%'`);
  assert.ok(users.every((u) => u.status === 'active'));
  // l'IP n'est pas bloquée
  assert.notEqual((await t.call('GET', '/api/health', { ip })).status, 403);
});

test('plafond horaire d\'inscriptions : 429 puis reprise', async () => {
  const ip = '192.0.2.99';
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await t.call('POST', '/api/auth/register', { body: { email: `cap${i}@test.invalid`, password: 'Motdepasse123' }, ip })).status;
  assert.equal(last, 429);
});

test('suppression du compte et des données (§1)', async () => {
  const u = await t.user({ phone: false });
  await t.call('POST', '/api/memories', { body: { content: 'Je préfère les réponses courtes' }, token: u.token, ip: u.ip });
  let r = await t.call('POST', '/api/account/delete', { body: { password: 'faux' }, token: u.token, ip: u.ip });
  assert.equal(r.status, 401);
  r = await t.call('POST', '/api/account/delete', { body: { password: u.password }, token: u.token, ip: u.ip });
  assert.equal(r.status, 200);
  assert.equal(await t.db.get(`SELECT id FROM users WHERE id=$1`, [u.id]), undefined);
  assert.equal((await t.db.query(`SELECT id FROM memories WHERE user_id=$1`, [u.id])).length, 0);
  assert.equal((await t.db.query(`SELECT id FROM sessions WHERE user_id=$1`, [u.id])).length, 0);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).status, 401);
});

test('connexion Google : signature RS256, audience, expiration vérifiées', async () => {
  const { setJwksFetcher } = await import('../server/lib/oidc.js');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as any), kid: 'k1', alg: 'RS256' };
  setJwksFetcher(async () => [jwk]);
  const mk = (claims: any, key = privateKey, kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  const ok = { iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, sub: 'g-123', email: 'g@test.invalid', email_verified: true };
  const ip = t.newIp();
  let r = await t.call('POST', '/api/auth/google', { body: { credential: mk(ok) }, ip });
  assert.equal(r.status, 200); assert.equal(r.body.user.emailVerified, true);
  assert.equal((await t.call('POST', '/api/auth/google', { body: { credential: mk({ ...ok, aud: 'autre' }) }, ip })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/google', { body: { credential: mk({ ...ok, exp: 1 }) }, ip })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/google', { body: { credential: mk({ ...ok, iss: 'https://evil.example' }) }, ip })).status, 401);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal((await t.call('POST', '/api/auth/google', { body: { credential: mk(ok, other.privateKey) }, ip })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/google', { body: { credential: mk({ ...ok, email_verified: false }) }, ip })).status, 401);
});
