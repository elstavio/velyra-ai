import { boot, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { totpAt } from '../server/lib/totp.js';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

let first: Awaited<ReturnType<typeof t.admin>>;

test('première connexion admin : 2FA obligatoire, codes de secours affichés une fois et stockés hachés (§9)', async () => {
  first = await t.admin();
  assert.equal(first.recovery!.length, 10);
  const row = await t.db.get<any>(`SELECT recovery_codes, totp_secret_enc, password_hash FROM users WHERE email=$1`, [ADMIN_EMAIL]);
  for (const c of first.recovery!) assert.ok(!row.recovery_codes.includes(c));
  assert.ok(!row.totp_secret_enc.includes(first.secret));
  assert.ok(row.password_hash.startsWith('scrypt$') && !row.password_hash.includes(ADMIN_PASSWORD));
  const me = await t.call('GET', '/api/admin/me', { token: first.token, ip: first.ip });
  assert.equal(me.status, 200);
  const dash = await t.call('GET', '/api/admin/dashboard', { token: first.token, ip: first.ip });
  assert.equal(dash.status, 200);
  for (const k of ['users', 'revenue', 'wallets', 'securityAlerts', 'aiStats', 'fraudOpen', 'activeSessions']) assert.ok(k in dash.body, k);
});

test('les codes de secours ne figurent ni dans la base en clair, ni dans les journaux de notification, ni dans les événements', async () => {
  const dump = JSON.stringify([
    await t.db.query(`SELECT * FROM notifications`), await t.db.query(`SELECT * FROM security_events`), await t.db.query(`SELECT * FROM audit_log`), await t.db.query(`SELECT * FROM login_logs`),
  ]);
  for (const c of first.recovery!) assert.ok(!dump.includes(c));
  assert.ok(!dump.includes(first.secret));
});

test('accès admin refusé sans session admin : utilisateur normal, anonyme, et connexion « utilisateur » du compte admin', async () => {
  const u = await t.user({ phone: false });
  assert.equal((await t.call('GET', '/api/admin/dashboard', { token: u.token, ip: u.ip })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/dashboard', { ip: u.ip })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, ip: t.newIp() })).status, 401);
  // une session admin ne donne pas accès aux routes utilisateur
  assert.equal((await t.call('GET', '/api/me', { token: first.token, ip: first.ip })).status, 401);
});

test('connexion suivante : mot de passe + TOTP ; nouvel appareil ou nouveau réseau → code email supplémentaire', async () => {
  // même appareil, même réseau : TOTP seul
  let r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device: first.device, ip: first.ip });
  assert.deepEqual(r.body.steps, ['totp']);
  // nouvel appareil : TOTP + email
  r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device: 'autre-appareil-0123456789', ip: first.ip });
  assert.deepEqual(r.body.steps, ['totp', 'email_otp']);
  // même appareil, nouveau réseau
  r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device: first.device, ip: '203.0.113.200' });
  assert.deepEqual(r.body.steps, ['totp', 'email_otp']);
  // sans identifiant d'appareil : toujours vérification supplémentaire
  r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, ip: first.ip });
  assert.ok(r.body.steps.includes('email_otp'));
});

test('connexion complète avec TOTP seul ; un mauvais code est refusé ; le jeton de tentative n\'est utilisable qu\'une fois', async () => {
  let r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device: first.device, ip: first.ip });
  const cid = r.body.challengeId;
  assert.equal((await t.call('POST', '/api/admin/auth/verify', { body: { challengeId: cid, step: 'totp', code: '000000' }, device: first.device, ip: first.ip })).status, 400);
  r = await t.call('POST', '/api/admin/auth/verify', { body: { challengeId: cid, step: 'totp', code: totpAt(first.secret, Date.now()) }, device: first.device, ip: first.ip });
  assert.equal(r.body.done, true); assert.ok(r.body.token);
  r = await t.call('POST', '/api/admin/auth/verify', { body: { challengeId: cid, step: 'totp', code: totpAt(first.secret, Date.now()) }, device: first.device, ip: first.ip });
  assert.equal(r.status, 401);
});

test('mauvais mot de passe admin : message neutre, événement de sécurité, verrouillage après 5 échecs', async () => {
  const ip = t.newIp();
  let r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: 'faux-mot-de-passe' }, ip });
  assert.equal(r.status, 401);
  for (let i = 0; i < 4; i++) r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: 'faux-mot-de-passe' }, ip });
  r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, ip });
  assert.equal(r.status, 423);
  assert.ok((await t.db.query(`SELECT id FROM security_events WHERE type='admin_locked'`)).length >= 1);
  await t.db.run(`UPDATE users SET locked_until=NULL, failed_logins=0 WHERE email=$1`, [ADMIN_EMAIL]);
});

test('la tentative de connexion expire après 20 minutes (§9)', async () => {
  const r = await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device: first.device, ip: first.ip });
  const cid = r.body.challengeId;
  const row = await t.db.get<any>(`SELECT expires_at, created_at FROM login_challenges WHERE id=$1`, [cid]);
  const minutes = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60_000;
  assert.ok(Math.abs(minutes - 20) < 0.1, `durée ${minutes} min`);
  await t.db.run(`UPDATE login_challenges SET expires_at=$2 WHERE id=$1`, [cid, new Date(Date.now() - 1000).toISOString()]);
  const v = await t.call('POST', '/api/admin/auth/verify', { body: { challengeId: cid, step: 'totp', code: totpAt(first.secret, Date.now()) }, device: first.device, ip: first.ip });
  assert.equal(v.status, 401); assert.equal(v.body.error.code, 'challenge_expired');
});

test('code de secours : fonctionne une seule fois, alerte de sécurité émise', async () => {
  const code = first.recovery![0];
  const login = async () => (await t.call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device: first.device, ip: first.ip })).body.challengeId;
  let r = await t.call('POST', '/api/admin/auth/verify', { body: { challengeId: await login(), step: 'recovery', code }, device: first.device, ip: first.ip });
  assert.equal(r.body.done, true);
  r = await t.call('POST', '/api/admin/auth/verify', { body: { challengeId: await login(), step: 'recovery', code }, device: first.device, ip: first.ip });
  assert.equal(r.status, 400);
  assert.ok((await t.db.query(`SELECT id FROM security_events WHERE type='admin_recovery_code_used'`)).length === 1);
});

test('session admin à durée limitée : expiration par inactivité', async () => {
  const a = await t.admin(first.device, first.ip, first.secret);
  assert.equal((await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip })).status, 200);
  await t.db.run(`UPDATE sessions SET last_seen_at=$1 WHERE is_admin=1`, [new Date(Date.now() - 3 * 3_600_000).toISOString()]);
  assert.equal((await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip })).status, 401);
});

test('défense (§8) : blocage automatique d\'une IP après échecs massifs, sondage de chemins sensibles, preuves chaînées', async () => {
  const bad = '198.18.0.5';
  for (let i = 0; i < 30; i++) await t.call('POST', '/api/auth/login', { body: { email: `x${i}@test.invalid`, password: 'faux' }, ip: bad });
  assert.equal((await t.call('GET', '/api/health', { ip: bad })).status, 403);
  assert.equal((await t.call('GET', '/api/health', { ip: '198.18.0.6' })).status, 200);
  const probe = '198.18.0.7';
  for (let i = 0; i < 8; i++) await t.call('GET', '/.env', { ip: probe });
  assert.equal((await t.call('GET', '/api/health', { ip: probe })).status, 403);

  const adm = await t.admin(first.device, first.ip, first.secret);
  const ev = await t.call('GET', '/api/admin/security/events?severity=high', { token: adm.token, ip: adm.ip });
  assert.ok(ev.body.events.some((e: any) => e.type === 'ip_blocked'));
  // alerte envoyée au propriétaire pour un événement sévère
  assert.ok(t.devOutbox.some((m) => m.to === ADMIN_EMAIL && /Alerte sécurité/.test(m.subject ?? '')));
  // le propriétaire peut lever / rendre permanent le blocage
  assert.equal((await t.call('POST', '/api/admin/security/blocks/remove', { body: { ip: bad }, token: adm.token, ip: adm.ip })).status, 200);
  assert.equal((await t.call('GET', '/api/health', { ip: bad })).status, 200);
  await t.call('POST', '/api/admin/security/blocks', { body: { ip: bad, permanent: true, reason: 'récidive' }, token: adm.token, ip: adm.ip });
  assert.equal((await t.call('GET', '/api/health', { ip: bad })).status, 403);
  // chaîne de hachage intègre, puis altération détectée
  assert.equal((await t.call('GET', '/api/admin/security/verify-chain', { token: adm.token, ip: adm.ip })).body.ok, true);
  const victim = await t.db.get<any>(`SELECT id FROM security_events ORDER BY created_at LIMIT 1 OFFSET 2`);
  await t.db.run(`UPDATE security_events SET detail='{"altere":true}' WHERE id=$1`, [victim.id]);
  const chk = await t.call('GET', '/api/admin/security/verify-chain', { token: adm.token, ip: adm.ip });
  assert.equal(chk.body.ok, false); assert.equal(chk.body.brokenAt, victim.id);
  const evidence = await t.call('GET', '/api/admin/security/evidence', { token: adm.token, ip: adm.ip });
  assert.equal(evidence.status, 200); assert.ok(evidence.body.events.length > 0);
});

test('signalement manuel + revue humaine : aucune suspension sans décision ; la suspension coupe les sessions (§2)', async () => {
  const adm = await t.admin(first.device, first.ip, first.secret);
  const u = await t.user({ phone: false });
  const rep = await t.call('POST', '/api/admin/fraud', { body: { userId: u.id, reason: 'Création de comptes multiples suspectée' }, token: adm.token, ip: adm.ip });
  assert.equal(rep.status, 200);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).status, 200); // toujours actif
  const rv = await t.call('POST', `/api/admin/fraud/${rep.body.id}/review`, { body: { decision: 'confirm', suspend: true, note: 'Confirmé' }, token: adm.token, ip: adm.ip });
  assert.equal(rv.status, 200);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, ip: u.ip })).body.error.code, 'account_disabled');
  assert.equal((await t.call('POST', `/api/admin/fraud/${rep.body.id}/review`, { body: { decision: 'dismiss' }, token: adm.token, ip: adm.ip })).status, 409);
  // réactivation
  await t.call('POST', `/api/admin/users/${u.id}/status`, { body: { status: 'active', reason: 'erreur' }, token: adm.token, ip: adm.ip });
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email: u.email, password: u.password }, ip: u.ip })).status, 200);
  // un admin ne peut pas être suspendu
  const me = await t.db.get<any>(`SELECT id FROM users WHERE role='admin'`);
  assert.equal((await t.call('POST', `/api/admin/users/${me.id}/status`, { body: { status: 'suspended' }, token: adm.token, ip: adm.ip })).status, 403);
});

test('tableau de bord, revenus, export CSV, tarifs (multiple de 5), journal d\'audit', async () => {
  const adm = await t.admin(first.device, first.ip, first.secret);
  const u = await t.user();
  const c = await t.call('POST', '/api/payments/checkout', { body: { planCode: 'pro', country: 'CI', method: 'wave' }, token: u.token, ip: u.ip });
  await t.call('POST', `/mock-pay/${c.body.paymentUrl.split('/').pop()}/accept`, { ip: '198.51.100.91' });
  const dash = await t.call('GET', '/api/admin/dashboard', { token: adm.token, ip: adm.ip });
  assert.equal(dash.body.revenue.today.XOF, 5000);
  assert.ok(dash.body.users.byCountry.some((x: any) => x.country === 'CI'));
  assert.ok(dash.body.recentPayments.length >= 1);
  const csv = await t.call('GET', '/api/admin/reports/revenue?format=csv', { token: adm.token, ip: adm.ip });
  assert.match(csv.body, /^date,devise,total,nombre_paiements\n.+XOF,5000,1/m);
  assert.equal((await t.call('PUT', '/api/admin/plans/pro/price', { body: { currency: 'XOF', amount: 5003 }, token: adm.token, ip: adm.ip })).status, 400);
  assert.equal((await t.call('PUT', '/api/admin/plans/pro/price', { body: { currency: 'XOF', amount: 6000 }, token: adm.token, ip: adm.ip })).status, 200);
  assert.equal((await t.call('GET', '/api/plans?country=CI')).body.plans[0].price.amount, 6000);
  const audit = await t.call('GET', '/api/admin/audit', { token: adm.token, ip: adm.ip });
  assert.ok(audit.body.audit.some((a: any) => a.action === 'plan_price'));
  assert.equal((await t.call('POST', '/api/admin/auth/logout', { token: adm.token, ip: adm.ip })).status, 200);
  assert.equal((await t.call('GET', '/api/admin/me', { token: adm.token, ip: adm.ip })).status, 401);
});

test('WAF logiciel : corps JSON avec clé de pollution de prototype rejeté (400), texte libre légitime jamais filtré', async () => {
  const ip = t.newIp();
  // `{ __proto__: … }` en syntaxe littérale change le prototype plutôt que de créer une propriété propre ;
  // on construit donc le corps via JSON.parse, comme le ferait un vrai client HTTP attaquant.
  const bad1 = await t.call('POST', '/api/auth/register', { body: JSON.parse('{"email":"waf1@test.invalid","password":"Motdepasse123","__proto__":{"polluted":1}}'), ip });
  assert.equal(bad1.status, 400); assert.equal(bad1.body.error.code, 'invalid_body');
  const bad2 = await t.call('POST', '/api/auth/register', { body: { email: 'waf2@test.invalid', password: 'Motdepasse123', nested: { a: { constructor: { x: 1 } } } }, ip });
  assert.equal(bad2.status, 400);
  // texte libre légitime (ex. demander à l'IA d'expliquer du code/SQL) : jamais bloqué par ce garde, seule la structure est vérifiée
  const u = await t.user();
  const mem = await t.call('POST', '/api/memories', { body: { content: "Exemple : SELECT * FROM users WHERE id='1' OR '1'='1'; <script>alert(1)</script>" }, token: u.token, ip: u.ip });
  assert.equal(mem.status, 200);
});

test('piège anti-intrusion (honeypot) : routes-leurres jamais utilisées par le vrai frontend → blocage immédiat + alerte critique + capture purgeable', async () => {
  const spy = '198.18.0.42';
  t.devOutbox.length = 0;
  const hit = await t.call('GET', '/api/admin/export-wallet-keys', { ip: spy });
  assert.equal(hit.status, 200); // réponse plausible, aucune vraie donnée
  assert.equal(hit.body.ok, true);
  // l'IP est bloquée immédiatement pour TOUTE autre route, sans attendre un seuil
  assert.equal((await t.call('GET', '/api/health', { ip: spy })).status, 403);
  // alerte critique immédiate au propriétaire (le type d'événement figure dans le sujet)
  assert.ok(t.devOutbox.some((m) => m.to === ADMIN_EMAIL && /Alerte sécurité \(critical\) : honeypot_triggered/.test(m.subject ?? '')));
  const adm = await t.admin(first.device, first.ip, first.secret);
  const ov = await t.call('GET', '/api/admin/security/overview', { token: adm.token, ip: adm.ip });
  assert.equal(ov.status, 200);
  assert.ok(ov.body.honeypot.some((h: any) => h.ip === spy && h.path === '/api/admin/export-wallet-keys'));
  assert.ok(ov.body.retentionDays >= 1);
  // purge : les informations captées disparaissent (mais la chaîne de preuve security_events, elle, reste intacte)
  await t.db.run(`UPDATE honeypot_hits SET created_at=$1`, [new Date(Date.now() - 20 * 86_400_000).toISOString()]);
  const purge = await t.call('POST', '/api/admin/security/honeypot/purge', { token: adm.token, ip: adm.ip });
  assert.ok(purge.body.deleted >= 1);
  assert.equal((await t.db.get<any>(`SELECT COUNT(*) AS n FROM honeypot_hits WHERE ip=$1`, [spy]))!.n, 0);
});

test('retrait : aucune sortie de fonds sans confirmation par lien envoyé par email, même déclenchée depuis l\'admin', async () => {
  const { confirmPayout } = await import('../server/services/payouts.js');
  const u = await t.user();
  const adm = await t.admin(first.device, first.ip, first.secret);
  await t.call('POST', '/api/admin/payout-accounts', { body: { channel: 'wave', country: 'CI', phone: '0708080808' }, token: adm.token, ip: adm.ip });
  const c = await t.call('POST', '/api/payments/checkout', { body: { planCode: 'pro', country: 'CI', method: 'wave' }, token: u.token, ip: u.ip });
  const ref = c.body.paymentUrl.split('/').pop();
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.90' });
  t.devOutbox.length = 0;
  const run1 = await t.call('POST', '/api/admin/payouts/run', { token: adm.token, ip: adm.ip });
  assert.equal(run1.body.sent, 0); // email envoyé, mais rien n'est sorti
  const mail = t.devOutbox.find((m) => m.to === ADMIN_EMAIL && /Confirmation requise pour un retrait/.test(m.subject ?? ''));
  assert.ok(mail);
  const link = /https?:\/\/\S+\/api\/payouts\/confirm\/\S+/.exec(mail!.body)![0];
  const token = link.split('/').pop()!;
  // lien invalide refusé
  assert.equal((await confirmPayout(t.db, 'faux-token', '1.2.3.4')).ok, false);
  const ok = await confirmPayout(t.db, token, '1.2.3.4');
  assert.equal(ok.ok, true);
  const run2 = await t.call('POST', '/api/admin/payouts/run', { token: adm.token, ip: adm.ip });
  assert.equal(run2.body.sent, 1); // confirmé → exécuté
});

test('nouvel appareil/IP : alerte email envoyée à l\'utilisateur à la première connexion depuis un appareil inconnu', async () => {
  const ip = t.newIp(); const email = `nd${Date.now()}@test.invalid`; const password = 'Motdepasse123';
  await t.call('POST', '/api/auth/register', { body: { email, password }, ip });
  t.devOutbox.length = 0;
  await t.call('POST', '/api/auth/login', { body: { email, password }, ip, device: 'appareil-abc-0123456789' });
  assert.ok(t.devOutbox.some((m) => m.to === email && /Nouvelle connexion détectée/.test(m.subject ?? '')));
  // même appareil ensuite : plus d'alerte
  t.devOutbox.length = 0;
  await t.call('POST', '/api/auth/login', { body: { email, password }, ip, device: 'appareil-abc-0123456789' });
  assert.ok(!t.devOutbox.some((m) => m.to === email && /Nouvelle connexion détectée/.test(m.subject ?? '')));
});
