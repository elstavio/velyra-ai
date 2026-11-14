import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
let I: typeof import('../server/services/integrity.js');
let A: typeof import('../server/services/sysagents.js');
before(async () => { t = await boot(); I = await import('../server/services/integrity.js'); A = await import('../server/services/sysagents.js'); });
after(async () => { await t.close(); });
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const openIds = async () => (await t.db.query<any>(`SELECT check_id FROM integrity_findings WHERE resolved_at IS NULL`)).map((r) => r.check_id).sort();

test('état sain : aucun contrôle en anomalie', async () => {
  const rep = await I.runIntegrity(t.db, 'test'); assert.equal(rep.open.length, 0, JSON.stringify(rep.open)); assert.equal(rep.ran, I.CHECKS.length); assert.ok(rep.ran >= 15);
});

test('solde de jetons ≠ journal : anomalie CRITIQUE, alerte immédiate une seule fois, résolue quand corrigée', async () => {
  const u = await t.user();
  await t.db.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ($1,50,$2)`, [u.id, iso()]); // solde sans écriture au journal
  const before = t.devOutbox.length;
  const r1 = await I.runIntegrity(t.db, 'test'); assert.deepEqual(r1.open.map((o) => o.id), ['token_sum']); assert.equal(r1.open[0].severity, 'critical');
  assert.ok(t.devOutbox.slice(before).some((m) => /ANOMALIE CRITICAL/.test(m.subject ?? '') && /token_sum|solde 50/.test(m.body)), 'alerte propriétaire');
  const n1 = t.devOutbox.length; await I.runIntegrity(t.db, 'test'); assert.equal(t.devOutbox.length, n1, 'pas de renotification');
  await t.db.run(`DELETE FROM token_balances WHERE user_id=$1`, [u.id]);
  assert.equal((await I.runIntegrity(t.db, 'test')).open.length, 0); assert.deepEqual(await openIds(), []);
});

test('portefeuille, paiement non livré, abonnement orphelin, solde négatif : détectés', async () => {
  const u = await t.user();
  await t.db.run(`INSERT INTO wallets (currency,balance,updated_at) VALUES ('XOF',1000,$1)`, [iso()]);
  await t.db.run(`INSERT INTO payments (id,user_id,plan_code,amount,currency,country,region,provider,channel,provider_ref,status,created_at,updated_at) VALUES ('pay-x',$1,'pro',5000,'XOF','CI','west_africa','mock','wave','REFX','succeeded',$2,$2)`, [u.id, iso()]);
  await t.db.run(`INSERT INTO subscriptions (id,user_id,plan_code,payment_id,starts_at,ends_at,created_at) VALUES ('sub-x',$1,'pro','inexistant',$2,$3,$2)`, [u.id, iso(), iso(86_400_000)]);
  await t.db.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ('neg',-3,$1)`, [iso()]);
  await I.runIntegrity(t.db, 'test');
  const ids = await openIds(); for (const id of ['wallet_sum', 'payments_fulfilled', 'subscriptions_orphan', 'token_negative']) assert.ok(ids.includes(id), id + ' ' + ids);
  await t.db.run(`DELETE FROM wallets WHERE currency='XOF'`); await t.db.run(`DELETE FROM payments WHERE id='pay-x'`); await t.db.run(`DELETE FROM subscriptions WHERE id='sub-x'`); await t.db.run(`DELETE FROM token_balances WHERE user_id='neg'`);
  assert.equal((await I.runIntegrity(t.db, 'test')).open.length, 0);
});

test('correction immédiate : tâche bloquée clôturée avec jeton restitué ; publication bloquée marquée échouée SANS republier', async () => {
  const { adminAdjust, getBalance } = await import('../server/services/tokens.js');
  const u = await t.user(); await adminAdjust(t.db, u.id, 5, 'test');
  // une tâche payée en jeton restée « running » depuis 1 h
  await t.db.run(`UPDATE token_balances SET balance=balance-1 WHERE user_id=$1`, [u.id]); await t.db.run(`INSERT INTO token_ledger (id,user_id,delta,balance_after,reason,ref,created_at) VALUES ('tl1',$1,-1,4,'task','task-stuck',$2)`, [u.id, iso(-3_600_000)]);
  await t.db.run(`INSERT INTO tasks (id,user_id,kind,billing,status,created_at) VALUES ('task-stuck',$1,'chat','tokens','running',$2)`, [u.id, iso(-3_600_000)]);
  await t.db.run(`INSERT INTO social_posts (id,user_id,platform,kind,body,status,content_hash,created_at,updated_at) VALUES ('post-stuck',$1,'facebook','api','x','publishing','h',$2,$2)`, [u.id, iso(-3_600_000)]);
  const calls: string[] = []; const real = globalThis.fetch; globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response('{}'); }) as any;
  try {
    const rep = await I.runIntegrity(t.db, 'test'); const fixed = rep.fixed.map((f) => f.id).sort();
    assert.deepEqual(fixed, ['posts_stuck', 'tasks_stuck']); assert.equal(rep.open.length, 0);
    assert.equal((await t.db.get<any>(`SELECT status FROM tasks WHERE id='task-stuck'`))!.status, 'failed'); assert.equal(await getBalance(t.db, u.id), 5, 'jeton restitué');
    assert.equal((await t.db.get<any>(`SELECT status FROM social_posts WHERE id='post-stuck'`))!.status, 'failed'); assert.equal(calls.length, 0, 'aucun appel réseau : pas de republication');
    const hist = await t.db.query<any>(`SELECT check_id, auto_fixed, fix_note FROM integrity_findings WHERE auto_fixed=1`); assert.ok(hist.some((h) => h.check_id === 'tasks_stuck' && /restitué/.test(h.fix_note)));
  } finally { globalThis.fetch = real; }
});

test('corrections sûres : essais hors bornes, états OAuth expirés ; prix invalide signalé (non corrigé automatiquement)', async () => {
  const u = await t.user(); await t.db.run(`UPDATE users SET trials_used=99 WHERE id=$1`, [u.id]);
  await t.db.run(`INSERT INTO oauth_states (state_hash,user_id,platform,expires_at) VALUES ('old',$1,'tiktok',$2)`, [u.id, iso(-7_200_000)]);
  await t.db.run(`UPDATE plan_prices SET amount=2503 WHERE plan_code='tokens_100' AND currency='XOF'`);
  const rep = await I.runIntegrity(t.db, 'test');
  assert.deepEqual(rep.fixed.map((f) => f.id).sort(), ['oauth_states_expired', 'trials_range']); assert.equal((await t.db.get<any>(`SELECT trials_used FROM users WHERE id=$1`, [u.id]))!.trials_used, 5);
  assert.deepEqual(rep.open.map((o) => o.id), ['plan_prices']); assert.match(rep.open[0].detail, /non multiples de 5/);
  await t.db.run(`UPDATE plan_prices SET amount=2500 WHERE plan_code='tokens_100' AND currency='XOF'`); assert.equal((await I.runIntegrity(t.db, 'test')).open.length, 0);
});

test('chaîne de sécurité falsifiée : anomalie critique', async () => {
  const { logEvent } = await import('../server/services/security.js'); await logEvent(t.db, 'evenement_test', 'low'); await logEvent(t.db, 'evenement_test_2', 'low');
  assert.ok(!(await I.runIntegrity(t.db, 'test')).open.some((o) => o.id === 'security_chain'), 'chaîne saine au départ');
  await t.db.run(`UPDATE security_events SET type='falsifie' WHERE id=(SELECT id FROM security_events ORDER BY created_at LIMIT 1)`);
  const rep = await I.runIntegrity(t.db, 'test'); assert.ok(rep.open.some((o) => o.id === 'security_chain'), JSON.stringify(rep.open));
});

// ------------------------------------------------------------------ auditeur
test('auditeur : chiffres non étayés détectés ; chiffres des faits et petits entiers tolérés', () => {
  assert.deepEqual(A.unsupportedNumbers('Il y a 987654 erreurs et 3 alertes sur 24 h', { errors: 12 }, []), ['987654']);
  assert.deepEqual(A.unsupportedNumbers('12 erreurs, taux 33,5 %', { errors: 12, rate: 33.5 }, []), []);
  assert.deepEqual(A.unsupportedNumbers('1 200 paiements', { n: 1200 }, []), ['200'], "« 1 200 » s'écrit en deux nombres : signalé par prudence (faux positif possible, sans gravité : la synthèse est alors remplacée par la version par règles)");
});

test('auditeur : synthèse IA avec chiffre inventé remplacée immédiatement ; relecture croisée par un AUTRE fournisseur ; ne peut qu\'ajouter des réserves', async () => {
  const { _setProvidersForTests } = await import('../server/services/llm.js'); const { config } = await import('../server/config.js');
  const oldP = config.ai.systemAgentProvider; config.ai.systemAgentProvider = 'openai'; let reviewerSeen = '';
  const mk = (id: string, fn: (m: any[]) => string) => ({ id, configured: () => true, call: async (m: any[]) => ({ text: fn(m), provider: id, model: id + '-m', tokensIn: 1, tokensOut: 1 }) });
  _setProvidersForTests([
    mk('openai', (m) => (/Auditeur/.test(m[0].content) ? '{"verdict":"ok","issues":[]}' : 'Tout va bien : 987654 incidents résolus aujourd\'hui.')) as any,
    mk('mistral', (m) => { reviewerSeen = m[0].content; return '{"verdict":"suspect","issues":["La synthèse de securite minimise une alerte"]}'; }) as any,
  ]);
  try {
    const day = new Date('2032-03-10T10:00:00Z');
    const r = await A.runDaily(t.db, 'cron', day);
    assert.ok(r.auditor.fixes.length >= 1, JSON.stringify(r.auditor)); assert.ok(r.auditor.fixes.every((f: string) => /987654/.test(f)));
    const sec = await t.db.get<any>(`SELECT summary, provider, error FROM agent_runs WHERE agent='securite' AND day='2032-03-10'`);
    assert.equal(sec.provider, 'rules'); assert.ok(!/987654/.test(sec.summary)); assert.match(sec.error, /remplacée par l'auditeur/);
    assert.match(reviewerSeen, /Auditeur indépendant/); assert.ok(r.auditor.issues.some((i: string) => /relecture croisée \(mistral\)/.test(i)));
    const run = await t.db.get<any>(`SELECT provider, summary FROM agent_runs WHERE agent='auditeur' AND day='2032-03-10'`); assert.equal(run.provider, 'mistral'); assert.match(run.summary, /SUSPECT/);
    // si le relecteur dit « ok », les contrôles déterministes restent seuls juges (aucune réserve retirée ni inventée)
    _setProvidersForTests([mk('openai', () => 'Synthèse sans chiffre.') as any, mk('mistral', () => '{"verdict":"ok","issues":[]}') as any]);
    const r2 = await A.audit(t.db, 'manual', new Date('2032-03-10T11:00:00Z')); assert.ok(!r2.issues.some((i) => /relecture croisée/.test(i)));
  } finally { _setProvidersForTests(null); config.ai.systemAgentProvider = oldP; }
});

test('auditeur : bilan du superviseur incohérent et anomalie critique ouverte malgré un bilan « ok » détectés', async () => {
  await t.db.run(`DELETE FROM agent_runs WHERE day='2032-04-01'`);
  const day = new Date('2032-04-01T10:00:00Z'); await A.runDaily(t.db, 'cron', day);
  const sup = await t.db.get<any>(`SELECT id, findings FROM agent_runs WHERE agent='superviseur' AND day='2032-04-01'`); const f = JSON.parse(sup.findings);
  f.overall = f.overall === 'ok' ? 'degraded' : 'ok'; await t.db.run(`UPDATE agent_runs SET findings=$2 WHERE id=$1`, [sup.id, JSON.stringify(f)]);
  const a = await A.audit(t.db, 'manual', day); assert.ok(a.issues.some((i) => /ne correspond pas à ses propres contrôles/.test(i)), JSON.stringify(a.issues));
  // anomalie critique ouverte alors que le bilan est ok
  f.overall = 'ok'; f.checks = f.checks.map((c: any) => ({ ...c, status: 'ok' })); f.gaps = []; await t.db.run(`UPDATE agent_runs SET findings=$2 WHERE id=$1`, [sup.id, JSON.stringify(f)]);
  await t.db.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ('ghost',7,$1)`, [iso()]); await I.runIntegrity(t.db, 'test');
  const b = await A.audit(t.db, 'manual', day); assert.ok(b.issues.some((i) => /anomalie\(s\) critique\(s\) ouverte\(s\) alors que le bilan est « ok »/.test(i)), JSON.stringify(b.issues));
  await t.db.run(`DELETE FROM token_balances WHERE user_id='ghost'`);
});

test('API admin : contrôles à la demande', async () => {
  const a = await t.admin(); const h = { token: a.token, device: 'dev-admin-0123456789abcdef', ip: '198.51.100.9' };
  assert.equal((await t.call('GET', '/api/admin/integrity')).status, 401);
  const ov = await t.call('GET', '/api/admin/integrity', h); assert.equal(ov.status, 200); assert.ok(ov.body.checks.length >= 15);
  const run = await t.call('POST', '/api/admin/integrity/run', { ...h, body: {} }); assert.equal(run.status, 200); assert.ok(Array.isArray(run.body.open));
});

test('API admin renforcée : jetons (ajustement audité), réseaux + coupe-circuit, finances, fiche 360°, exports CSV sûrs', async () => {
  const a = await t.admin(); const h = { token: a.token, device: 'dev-admin-0123456789abcdef', ip: '198.51.100.9' };
  const u = await t.user(); const call = (m: string, p: string, body?: unknown) => t.call(m, p, { ...h, body });
  for (const p of ['/api/admin/tokens', '/api/admin/social', '/api/admin/finance', `/api/admin/users/${u.id}/overview`, '/api/admin/export/payments']) assert.equal((await t.call('GET', p, { token: u.token, ip: u.ip })).status === 200, false, 'refusé aux non-admin : ' + p);
  // jetons
  assert.equal((await call('POST', '/api/admin/tokens/adjust', { email: u.email, delta: 100 })).status, 400, 'motif obligatoire');
  const adj = await call('POST', '/api/admin/tokens/adjust', { email: u.email, delta: 100, reason: 'geste commercial' }); assert.equal(adj.body.balance, 100);
  assert.equal((await call('POST', '/api/admin/tokens/adjust', { email: u.email, delta: -500, reason: 'trop' })).status, 409, 'jamais de solde négatif');
  assert.equal((await call('POST', '/api/admin/tokens/adjust', { email: 'inconnu@x.invalid', delta: 1, reason: 'test' })).status, 404);
  const tk = (await call('GET', '/api/admin/tokens')).body; assert.ok(tk.granted >= 100); assert.ok(tk.outstanding >= 100);
  assert.ok((await t.db.get<any>(`SELECT id FROM audit_log WHERE action='tokens_adjust'`)), 'ajustement journalisé');
  // fiche 360°
  const ov = (await call('GET', `/api/admin/users/${u.id}/overview`)).body; assert.equal(ov.user.email, u.email); assert.equal(ov.tokens.balance, 100); assert.ok(!JSON.stringify(ov).includes('access_enc'));
  assert.equal((await call('GET', '/api/admin/users/inconnu/overview')).status, 404);
  // réseaux + coupe-circuit
  const so = (await call('GET', '/api/admin/social')).body; assert.equal(so.killed, false); assert.equal(so.publishedWithoutApproval, 0);
  assert.equal((await call('POST', '/api/admin/social/kill', { on: true })).body.killed, true); assert.equal((await call('GET', '/api/admin/social')).body.killed, true);
  await call('POST', '/api/admin/social/kill', { on: false });
  // finances
  const fin = (await call('GET', '/api/admin/finance?days=30')).body; assert.ok(Array.isArray(fin.byDay) && Array.isArray(fin.byPlan) && typeof fin.activeSubscribers === 'number');
  // exports : en-têtes CSV, neutralisation des formules
  await t.db.run(`UPDATE users SET country='=HYPERLINK("x")' WHERE id=$1`, [u.id]);
  const csv = await t.call('GET', '/api/admin/export/users', h); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type')!, /text\/csv/);
  const body = typeof csv.body === 'string' ? csv.body : csv.body?._raw ?? JSON.stringify(csv.body); assert.ok(body.includes("'=HYPERLINK"), 'formule neutralisée : ' + String(body).slice(0, 200)); assert.match(String(body), /^created_at;email;country;status/);
  assert.equal((await call('GET', '/api/admin/export/inconnu')).status, 404);
});

test('coffre-fort de secrets : statut de présence uniquement (jamais les valeurs), rotation déclarative', async () => {
  const a = await t.admin(); const h = { token: a.token, device: 'dev-admin-0123456789abcdef', ip: '198.51.100.9' };
  const u = await t.user();
  assert.equal((await t.call('GET', '/api/admin/security/secrets', { token: u.token, ip: u.ip })).status, 403);
  const sv = await t.call('GET', '/api/admin/security/secrets', h);
  assert.equal(sv.status, 200);
  const enc = sv.body.items.find((i: any) => i.key === 'ENCRYPTION_KEY');
  assert.ok(enc.present); // configuré dans les tests
  assert.ok(!JSON.stringify(sv.body).match(/[A-Za-z0-9+/]{32,}={0,2}/)); // aucune valeur de secret (base64 plausible) ne fuite dans la réponse
  const missing = sv.body.items.find((i: any) => i.key === 'STRIPE_SECRET_KEY');
  assert.equal(missing.present, false); // pas configuré dans les tests
  assert.equal(missing.rotatedAt, null);
  const rot = await t.call('POST', '/api/admin/security/secrets/ENCRYPTION_KEY/rotated', h);
  assert.equal(rot.status, 200);
  const after = (await t.call('GET', '/api/admin/security/secrets', h)).body;
  assert.ok(after.items.find((i: any) => i.key === 'ENCRYPTION_KEY').rotatedAt);
  assert.equal((await t.call('POST', '/api/admin/security/secrets/INCONNU/rotated', h)).status, 404);
  assert.ok((await t.db.get<any>(`SELECT id FROM audit_log WHERE action='secret_rotation_declared'`)));
});
