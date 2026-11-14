import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });
const post = (u: any, path: string, body?: unknown) => t.call('POST', path, { body: body ?? {}, token: u.token, ip: u.ip });
const get = (u: any, path: string) => t.call('GET', path, { token: u.token, ip: u.ip });
const refOf = (url: string) => new URL(url, 'http://x').pathname.split('/').filter(Boolean)[1];

test('paquets de jetons : 100/500/1000/5000 aux prix demandés en XOF et XAF, sans durée', async () => {
  const u = await t.user({ country: 'CI' });
  const plans = (await t.call('GET', '/api/plans?country=CI', { ip: u.ip })).body.plans.filter((p: any) => p.features[0]?.startsWith('tokens:'));
  assert.deepEqual(plans.map((p: any) => [p.features[0], p.price.amount]).sort(), [['tokens:100', 2500], ['tokens:1000', 12000], ['tokens:5000', 20000], ['tokens:500', 8000]].sort());
  const cm = (await t.call('GET', '/api/plans?country=CM', { ip: u.ip })).body.plans.find((p: any) => p.code === 'tokens_500');
  assert.equal(cm.price.currency, 'XAF'); assert.equal(cm.price.amount, 8000);
});

test('achat d\'un paquet : jetons crédités une seule fois, aucun abonnement créé, solde visible, journal', async () => {
  const u = await t.user({ country: 'CI' });
  assert.equal((await get(u, '/api/tokens')).body.balance, 0);
  const co = await post(u, '/api/payments/checkout', { planCode: 'tokens_500', country: 'CI', method: 'wave' });
  assert.equal(co.status, 200, JSON.stringify(co.body)); assert.equal(co.body.amount, 8000);
  const ref = refOf(co.body.paymentUrl);
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.91' });
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.91' }); // rejeu
  const tk = (await get(u, '/api/tokens')).body;
  assert.equal(tk.balance, 500); assert.equal(tk.history.length, 1); assert.equal(tk.history[0].reason, 'purchase');
  assert.equal((await t.db.get<any>(`SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=$1`, [u.id]))!.n, 0);
  const me = (await get(u, '/api/me')).body.entitlements; assert.equal(me.tokens, 500); assert.equal(me.platformAccess, false);
});

test('consommation : essais gratuits d\'abord, puis jetons ; 1 jeton par tâche ; solde vide → 402', async () => {
  const u = await t.user();
  await t.db.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ($1,3,$2)`, [u.id, new Date().toISOString()]);
  const billings: string[] = [];
  for (let i = 0; i < 8; i++) { const r = await post(u, '/api/chat', { message: `q${i}` }); billings.push(r.status === 200 ? r.body.billing : String(r.status)); }
  assert.deepEqual(billings, ['trial', 'trial', 'trial', 'trial', 'trial', 'tokens', 'tokens', 'tokens']);
  const r = await post(u, '/api/chat', { message: 'encore' }); assert.equal(r.status, 402);
  assert.equal((await get(u, '/api/tokens')).body.balance, 0);
});

test('abonné : usage équitable atteint → les jetons prennent le relais ; sans jetons → 429', async () => {
  const { config } = await import('../server/config.js'); const old = config.dailyTaskCap; config.dailyTaskCap = 2;
  try {
    const u = await t.user();
    await t.db.run(`INSERT INTO subscriptions (id,user_id,plan_code,payment_id,starts_at,ends_at,created_at) VALUES ($1,$2,'pro',$3,$4,$5,$4)`, [crypto.randomUUID(), u.id, crypto.randomUUID(), new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86_400_000).toISOString()]);
    await t.db.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ($1,1,$2)`, [u.id, new Date().toISOString()]);
    const b: string[] = []; for (let i = 0; i < 4; i++) { const r = await post(u, '/api/chat', { message: `q${i}` }); b.push(r.status === 200 ? r.body.billing : String(r.status)); }
    assert.deepEqual(b, ['subscription', 'subscription', 'tokens', '429']);
  } finally { config.dailyTaskCap = old; }
});

test('tâche échouée : le jeton est restitué une seule fois ; simultanéité : jamais plus de tâches que de jetons', async () => {
  const { withTask } = await import('../server/services/entitlements.js');
  const u = await t.user(); const row = (await t.db.get<any>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
  await t.db.run(`UPDATE users SET trials_used=5 WHERE id=$1`, [u.id]); row.trials_used = 5;
  await (await import('../server/services/tokens.js')).adminAdjust(t.db, u.id, 3, 'test');
  await assert.rejects(() => withTask(t.db, row, 'test', {}, async () => { throw new Error('panne fournisseur'); }), /panne/);
  assert.equal((await get(u, '/api/tokens')).body.balance, 3);
  const res = await Promise.allSettled(Array.from({ length: 10 }, () => withTask(t.db, row, 'test', {}, async () => 'ok')));
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 3);
  const bal = await get(u, '/api/tokens'); assert.equal(bal.body.balance, 0);
  const sum = (await t.db.get<any>(`SELECT COALESCE(SUM(delta),0) AS s FROM token_ledger WHERE user_id=$1`, [u.id]))!.s; assert.equal(sum, 0, 'la somme du journal égale le solde');
});

test('alertes de solde bas : email à 10 jetons restants et à 0', async () => {
  const u = await t.user(); await t.db.run(`UPDATE users SET trials_used=5 WHERE id=$1`, [u.id]);
  await t.db.run(`INSERT INTO token_balances (user_id,balance,updated_at) VALUES ($1,11,$2)`, [u.id, new Date().toISOString()]);
  const before = t.devOutbox.length;
  for (let i = 0; i < 11; i++) assert.equal((await post(u, '/api/chat', { message: `q${i}` })).status, 200);
  const subjects = t.devOutbox.slice(before).filter((m) => m.to === u.email).map((m) => m.subject);
  assert.ok(subjects.some((s) => /il vous reste 10 jetons/.test(s ?? ''))); assert.ok(subjects.some((s) => /jetons sont épuisés/.test(s ?? '')));
});
