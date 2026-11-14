import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

async function checkout(u: { token: string; ip: string }, body: any) {
  return t.call('POST', '/api/payments/checkout', { body, token: u.token, ip: u.ip });
}
const refOf = (url: string) => url.split('/').pop()!;
const accept = (ref: string) => t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.77' });
const wallet = async (cur = 'XOF') => (await t.db.get<any>(`SELECT balance FROM wallets WHERE currency=$1`, [cur]))?.balance ?? 0;

test('plans et moyens de paiement adaptés à la région (§3)', async () => {
  let r = await t.call('GET', '/api/plans?country=CI');
  assert.equal(r.body.region, 'west_africa'); assert.equal(r.body.currency, 'XOF');
  assert.deepEqual(r.body.methods.map((m: any) => m.id), ['wave', 'mtn', 'orange', 'moov', 'card']);
  assert.equal(r.body.plans[0].price.currency, 'XOF');
  r = await t.call('GET', '/api/plans?country=CM');
  assert.deepEqual(r.body.methods.map((m: any) => m.id), ['card']);
  r = await t.call('GET', '/api/plans?country=FR');
  assert.equal(r.body.region, 'europe');
  assert.ok(r.body.methods.some((m: any) => m.id === 'sepa' && m.available === false));
});

test('paiement Wave réussi : abonnement activé, wallet crédité, transfert envoyé (§4, §5)', async () => {
  const { MockPayouts } = await import('../server/providers/mock.js');
  MockPayouts.sent.length = 0;
  const u = await t.user();
  const adm = await t.admin();
  const acc = await t.call('POST', '/api/admin/payout-accounts', { body: { channel: 'wave', country: 'CI', phone: '0707070707' }, token: adm.token, ip: adm.ip });
  assert.equal(acc.status, 200);
  const before = await wallet();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.amount, 5000); assert.equal(c.body.currency, 'XOF');
  // tant que le paiement n'est pas validé : aucun accès
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).body.entitlements.platformAccess, false);
  const ref = refOf(c.body.paymentUrl);
  const res = await accept(ref);
  assert.equal(res.status, 303);
  const me = await t.call('GET', '/api/me', { token: u.token, ip: u.ip });
  assert.equal(me.body.entitlements.platformAccess, true);
  assert.equal((await t.call('GET', `/api/payments/${ref}`, { token: u.token, ip: u.ip })).body.status, 'succeeded');
  assert.equal(await wallet(), before + 5000);
  // le transfert automatique part (traitement des transferts) — après confirmation par email (lien cliqué)
  const { _confirmForTests } = await import('../server/services/payouts.js');
  const payoutRow = await t.db.get<any>(`SELECT p.id FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [ref]);
  let first = await t.call('POST', '/api/admin/payouts/run', { token: adm.token, ip: adm.ip });
  assert.equal(first.body.sent, 0); // reste en attente tant que le lien de confirmation n'a pas été cliqué
  assert.ok(t.devOutbox.some((m) => m.to === 'owner@test.invalid' && /Confirmation requise pour un retrait/.test(m.subject ?? '')));
  await _confirmForTests(t.db, payoutRow.id);
  const run = await t.call('POST', '/api/admin/payouts/run', { token: adm.token, ip: adm.ip });
  assert.equal(run.body.sent, 1);
  assert.equal(MockPayouts.sent[0].amount, 5000); assert.equal(MockPayouts.sent[0].prefix, '225'); assert.equal(MockPayouts.sent[0].phone, '0707070707');
  assert.equal(await wallet(), before); // débité du wallet après envoi
  const ov = await t.call('GET', '/api/admin/wallet', { token: adm.token, ip: adm.ip });
  assert.ok(ov.body.accounts[0].masked.endsWith('0707') && !ov.body.accounts[0].masked.includes('07070707')); // numéro masqué, 4 derniers chiffres seulement
  // abonné : service sans consommer d'essai
  const chat = await t.call('POST', '/api/chat', { body: { message: 'Bonjour' }, token: u.token, ip: u.ip });
  assert.equal(chat.body.billing, 'subscription');
});

test('le numéro propriétaire est chiffré au repos', async () => {
  const rows = await t.db.query<any>(`SELECT phone_enc FROM payout_accounts`);
  assert.ok(rows.length > 0);
  for (const r of rows) { assert.ok(r.phone_enc.startsWith('v1:')); assert.ok(!r.phone_enc.includes('0707070707')); }
});

test('notification rejouée 5 fois : un seul crédit, un seul abonnement, un seul transfert (anti double transaction §5.1)', async () => {
  const u = await t.user();
  const before = await wallet();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'orange' });
  const ref = refOf(c.body.paymentUrl);
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.77' });
  await Promise.all(Array.from({ length: 5 }, () => t.call('POST', '/api/webhooks/cinetpay', { body: { cpm_trans_id: ref }, form: true, ip: '198.51.100.78' })));
  assert.equal(await wallet(), before + 5000);
  assert.equal((await t.db.query(`SELECT id FROM subscriptions WHERE user_id=$1`, [u.id])).length, 1);
  assert.equal((await t.db.query(`SELECT p.id FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [ref])).length, 1);
  assert.equal((await t.db.query(`SELECT id FROM wallet_ledger WHERE kind='credit' AND note=$1`, [`paiement ${ref}`])).length, 1);
});

test('fausse notification pour un paiement non réglé : rien n\'est activé (vérification serveur-à-serveur)', async () => {
  const u = await t.user();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'mtn' });
  const ref = refOf(c.body.paymentUrl);
  const r = await t.call('POST', '/api/webhooks/cinetpay', { body: { cpm_trans_id: ref, cpm_error_message: 'SUCCES' }, form: true, ip: '198.51.100.79' });
  assert.equal(r.status, 200);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).body.entitlements.platformAccess, false);
  assert.equal((await t.db.get<any>(`SELECT status FROM payments WHERE provider_ref=$1`, [ref])).status, 'pending');
  assert.equal((await t.call('POST', '/api/webhooks/cinetpay', { body: { cpm_trans_id: 'INCONNU' }, form: true, ip: '198.51.100.79' })).status, 200);
});

test('montant incohérent chez l\'agrégateur : refusé, signalé, rien n\'est crédité', async () => {
  const { MockPayments } = await import('../server/providers/mock.js');
  const u = await t.user();
  const before = await wallet();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
  const ref = refOf(c.body.paymentUrl);
  await (t.app.payments as InstanceType<typeof MockPayments>).setState(ref, 'ACCEPTED', 100);
  await t.call('POST', '/api/webhooks/cinetpay', { body: { cpm_trans_id: ref }, form: true, ip: '198.51.100.80' });
  const p = await t.db.get<any>(`SELECT status, fraud_flag FROM payments WHERE provider_ref=$1`, [ref]);
  assert.equal(p.status, 'failed'); assert.equal(p.fraud_flag, 1);
  assert.equal(await wallet(), before);
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).body.entitlements.platformAccess, false);
  const ev = await t.db.query<any>(`SELECT severity FROM security_events WHERE type='payment_amount_mismatch'`);
  assert.equal(ev[0].severity, 'high');
});

test('paiement refusé : échec enregistré, aucun accès', async () => {
  const u = await t.user();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'moov' });
  const ref = refOf(c.body.paymentUrl);
  await t.call('POST', `/mock-pay/${ref}/refuse`, { ip: '198.51.100.81' });
  assert.equal((await t.call('GET', `/api/payments/${ref}`, { token: u.token, ip: u.ip })).body.status, 'failed');
  assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).body.entitlements.platformAccess, false);
});

test('validation du paiement : email, région, moyen indisponible, carte → coordonnées de facturation', async () => {
  const noMail = await (async () => { const ip = t.newIp(); const email = 'nm@test.invalid'; await t.call('POST', '/api/auth/register', { body: { email, password: 'Motdepasse123' }, ip }); return { token: (await t.call('POST', '/api/auth/login', { body: { email, password: 'Motdepasse123' }, ip })).body.token, ip }; })();
  assert.equal((await checkout(noMail, { planCode: 'pro', country: 'CI', method: 'wave' })).body.error.code, 'email_unverified');
  const u = await t.user();
  assert.equal((await checkout(u, { planCode: 'pro', country: 'CM', method: 'wave' })).body.error.code, 'method_not_offered');
  assert.equal((await checkout(u, { planCode: 'pro', country: 'FR', method: 'sepa' })).body.error.code, 'method_unavailable');
  assert.equal((await checkout(u, { planCode: 'inconnu', country: 'CI', method: 'wave' })).body.error.code, 'invalid_plan');
  assert.equal((await checkout(u, { planCode: 'pro', country: 'ZZ', method: 'wave' })).body.error.code, 'invalid_country');
  assert.equal((await checkout(u, { planCode: 'pro', country: 'CM', method: 'card' })).status, 400); // facturation manquante
  const ok = await checkout(u, { planCode: 'pro', country: 'CM', method: 'card', billing: { firstName: 'A', lastName: 'B', address: '1 rue X', city: 'Douala', zip: '12345', phone: '+237600000000' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.currency, 'XAF');
  const eu = await checkout(u, { planCode: 'pro', country: 'FR', method: 'card', billing: { firstName: 'A', lastName: 'B', address: '1 rue X', city: 'Paris', zip: '75001', phone: '+33600000000' } });
  assert.equal(eu.body.currency, 'USD');
});

test('abonnement prolongé (et non écrasé) lors d\'un second paiement', async () => {
  const u = await t.user();
  for (let i = 0; i < 2; i++) {
    const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
    await t.call('POST', `/mock-pay/${refOf(c.body.paymentUrl)}/accept`, { ip: '198.51.100.82' });
  }
  const subs = await t.db.query<any>(`SELECT starts_at, ends_at FROM subscriptions WHERE user_id=$1 ORDER BY starts_at`, [u.id]);
  assert.equal(subs.length, 2);
  assert.equal(subs[1].starts_at, subs[0].ends_at);
});

test('compte suspendu avant confirmation : paiement encaissé mais transfert retenu pour revue (§2/§5.3)', async () => {
  const u = await t.user();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
  await t.db.run(`UPDATE users SET status='suspended' WHERE id=$1`, [u.id]);
  await t.call('POST', `/mock-pay/${refOf(c.body.paymentUrl)}/accept`, { ip: '198.51.100.83' });
  const po = await t.db.get<any>(`SELECT p.status FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [refOf(c.body.paymentUrl)]);
  assert.equal(po.status, 'held');
});

test('échec de transfert : fonds conservés, nouvelle tentative programmée, alerte propriétaire, puis succès (§5.3)', async () => {
  const { MockPayouts } = await import('../server/providers/mock.js');
  const { processPayouts } = await import('../server/services/payouts.js');
  await processPayouts(t.db, t.app.payouts); // vide la file des transferts des tests précédents
  const u = await t.user();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
  const ref = refOf(c.body.paymentUrl);
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.84' });
  const payoutId = (await t.db.get<any>(`SELECT p.id FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [ref])).id;
  const { _confirmForTests } = await import('../server/services/payouts.js');
  await _confirmForTests(t.db, payoutId);
  const beforeBal = await wallet();
  t.devOutbox.length = 0;
  MockPayouts.failNext = 1;
  await processPayouts(t.db, t.app.payouts);
  let p = await t.db.get<any>(`SELECT status, attempts, next_attempt_at, last_error FROM payouts WHERE id=$1`, [payoutId]);
  assert.equal(p.status, 'failed'); assert.equal(p.attempts, 1); assert.ok(p.next_attempt_at > new Date().toISOString()); assert.ok(p.last_error);
  assert.equal(await wallet(), beforeBal); // aucun fonds perdu
  assert.ok(t.devOutbox.some((m) => m.to === 'owner@test.invalid' && /Échec de transfert/.test(m.subject ?? '')));
  await t.db.run(`UPDATE payouts SET next_attempt_at=$2 WHERE id=$1`, [payoutId, new Date(Date.now() - 1000).toISOString()]);
  await processPayouts(t.db, t.app.payouts);
  p = await t.db.get<any>(`SELECT status, attempts FROM payouts WHERE id=$1`, [payoutId]);
  assert.ok(['sent', 'confirmed'].includes(p.status)); assert.equal(p.attempts, 2);
  assert.equal(await wallet(), beforeBal - 5000);
});

test('transfert rejeté par l\'opérateur : fonds restitués au wallet puis nouvelle tentative débite une seule fois', async () => {
  const { processPayouts } = await import('../server/services/payouts.js');
  await processPayouts(t.db, t.app.payouts);
  const u = await t.user();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
  const ref = refOf(c.body.paymentUrl);
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.85' });
  const id = (await t.db.get<any>(`SELECT p.id FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [ref])).id;
  const { _confirmForTests } = await import('../server/services/payouts.js');
  await _confirmForTests(t.db, id);
  const real = t.app.payouts.check;
  const base = await wallet();
  // envoi accepté, puis rejet constaté au suivi
  t.app.payouts.check = async () => ({ state: 'failed', detail: 'REJ' });
  await processPayouts(t.db, t.app.payouts); // envoie puis constate le rejet
  assert.equal(await wallet(), base); // débité puis recrédité
  t.app.payouts.check = real;
  await t.db.run(`UPDATE payouts SET next_attempt_at=$2 WHERE id=$1`, [id, new Date(Date.now() - 1000).toISOString()]);
  await processPayouts(t.db, t.app.payouts);
  assert.equal(await wallet(), base - 5000);
});

test('sans compte de réception configuré : fonds conservés dans le wallet, pas d\'échec compté', async () => {
  const { processPayouts } = await import('../server/services/payouts.js');
  await t.db.run(`DELETE FROM payout_accounts`);
  const u = await t.user();
  const c = await checkout(u, { planCode: 'pro', country: 'CI', method: 'wave' });
  const ref = refOf(c.body.paymentUrl);
  await t.call('POST', `/mock-pay/${ref}/accept`, { ip: '198.51.100.86' });
  const noAcctId = (await t.db.get<any>(`SELECT p.id FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [ref])).id;
  const { _confirmForTests } = await import('../server/services/payouts.js');
  await _confirmForTests(t.db, noAcctId);
  await processPayouts(t.db, t.app.payouts);
  const p = await t.db.get<any>(`SELECT p.status, p.attempts, p.last_error FROM payouts p JOIN payments y ON y.id=p.payment_id WHERE y.provider_ref=$1`, [ref]);
  assert.equal(p.status, 'pending'); assert.equal(p.attempts, 0); assert.match(p.last_error, /compte/i);
});
