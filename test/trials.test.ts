import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const chat = (u: { token: string; ip: string }, message = 'Bonjour') => t.call('POST', '/api/chat', { body: { message }, token: u.token, ip: u.ip });

test('essais : email puis téléphone requis, 5 tâches gratuites, puis blocage avec invitation à payer (§2)', async () => {
  const noEmail = await (async () => {
    const ip = t.newIp(); const email = 'noverif@test.invalid';
    await t.call('POST', '/api/auth/register', { body: { email, password: 'Motdepasse123' }, ip });
    const token = (await t.call('POST', '/api/auth/login', { body: { email, password: 'Motdepasse123' }, ip })).body.token;
    return { token, ip };
  })();
  assert.equal((await chat(noEmail)).body.error.code, 'email_unverified');

  const noPhone = await t.user({ phone: false });
  assert.equal((await chat(noPhone)).body.error.code, 'phone_required');

  const u = await t.user();
  for (let i = 1; i <= 5; i++) {
    const r = await chat(u, `Question ${i}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.billing, 'trial');
  }
  const me = await t.call('GET', '/api/me', { token: u.token, ip: u.ip });
  assert.equal(me.body.entitlements.trialsRemaining, 0);
  const blocked = await chat(u, 'Sixième');
  assert.equal(blocked.status, 402); assert.equal(blocked.body.error.code, 'trial_exhausted'); assert.equal(blocked.body.error.paywall, true);
});

test('concurrence : 12 requêtes simultanées ne consomment jamais plus de 5 essais', async () => {
  const u = await t.user();
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => chat(u, `Parallèle ${i}`)));
  assert.equal(rs.filter((r) => r.status === 200).length, 5);
  assert.equal(rs.filter((r) => r.status === 402).length, 7);
  const row = await t.db.get<any>(`SELECT trials_used FROM users WHERE id=$1`, [u.id]);
  assert.equal(row.trials_used, 5);
});

test('un échec du fournisseur d\'IA restitue l\'essai consommé', async () => {
  const { _setProvidersForTests } = await import('../server/services/llm.js');
  const u = await t.user();
  _setProvidersForTests([{ id: 'ko', configured: () => true, model: () => 'x', call: async () => { throw new Error('panne'); } }]);
  const r = await chat(u);
  assert.equal(r.status, 502);
  _setProvidersForTests(null);
  const row = await t.db.get<any>(`SELECT trials_used FROM users WHERE id=$1`, [u.id]);
  assert.equal(row.trials_used, 0);
});

test('repli automatique du routeur de modèles vers le fournisseur suivant', async () => {
  const { _setProvidersForTests } = await import('../server/services/llm.js');
  const u = await t.user();
  _setProvidersForTests([
    { id: 'ko', configured: () => true, model: () => 'x', call: async () => { throw new Error('panne'); } },
    { id: 'ok', configured: () => true, model: () => 'y', call: async () => ({ text: 'bonjour', model: 'y' }) },
  ]);
  const r = await t.call('POST', '/api/chat', { body: { message: 'salut', provider: 'ko' }, token: u.token, ip: u.ip });
  _setProvidersForTests(null);
  assert.equal(r.status, 200); assert.equal(r.body.provider, 'ok');
});

test('compte suspendu : accès refusé immédiatement', async () => {
  const u = await t.user();
  await t.db.run(`UPDATE users SET status='suspended' WHERE id=$1`, [u.id]);
  assert.equal((await chat(u)).status, 403);
});
