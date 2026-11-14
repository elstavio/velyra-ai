import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync, createHash } from 'node:crypto';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

// ------------------------------------------------------------------ connexion Apple
test('connexion Apple : signature, émetteur, audience, expiration, nonce (brut ou haché)', async () => {
  const { setAppleJwksFetcher } = await import('../server/lib/oidc.js');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  setAppleJwksFetcher(async () => [{ ...(publicKey.export({ format: 'jwk' }) as any), kid: 'a1', alg: 'RS256' }]);
  const mk = (claims: any, key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'a1' })).toString('base64url'), p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url')}`;
  };
  const ok = { iss: 'https://appleid.apple.com', aud: 'test.velyra.service', exp: Math.floor(Date.now() / 1000) + 600, sub: 'apple-001', email: 'apple1@test.invalid', email_verified: 'true', nonce: 'n-123' };
  const ip = t.newIp();
  const r = await t.call('POST', '/api/auth/apple', { body: { idToken: mk(ok), nonce: 'n-123' }, ip });
  assert.equal(r.status, 200); assert.equal(r.body.user.emailVerified, true);
  // même compte au 2e passage, nonce haché accepté
  const hashed = createHash('sha256').update('n-456').digest('hex');
  const r2 = await t.call('POST', '/api/auth/apple', { body: { idToken: mk({ ...ok, nonce: hashed }), nonce: 'n-456' }, ip });
  assert.equal(r2.status, 200); assert.equal(r2.body.user.id, r.body.user.id);
  const bad = async (claims: any, nonce = 'n-123', key = privateKey) => (await t.call('POST', '/api/auth/apple', { body: { idToken: mk(claims, key), nonce }, ip })).status;
  assert.equal(await bad({ ...ok, aud: 'autre' }), 401);
  assert.equal(await bad({ ...ok, iss: 'https://evil.example' }), 401);
  assert.equal(await bad({ ...ok, exp: 1 }), 401);
  assert.equal(await bad(ok, 'mauvais-nonce'), 401);
  assert.equal(await bad(ok, 'n-123', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), 401);
  assert.equal(await bad({ ...ok, email_verified: 'false' }), 401);
  // un compte administrateur ne peut pas se connecter par Apple
  assert.equal(await bad({ ...ok, sub: 'x', email: 'owner@test.invalid' }), 401);
});

// ------------------------------------------------------------------ connexion par code email
test('connexion par code email : création, usage unique, mauvais code, pas d\'énumération, admin exclu', async () => {
  const ip = t.newIp(); const email = 'codeuser@test.invalid';
  const req = await t.call('POST', '/api/auth/code/request', { body: { email }, ip });
  assert.equal(req.status, 200); assert.deepEqual(req.body, { ok: true });
  assert.equal((await t.call('POST', '/api/auth/code/verify', { body: { email, code: '000000' }, ip })).status, 401);
  const code = t.lastCode(email);
  const ok = await t.call('POST', '/api/auth/code/verify', { body: { email, code }, ip });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.emailVerified, true);
  assert.equal((await t.call('GET', '/api/me', { token: ok.body.token, ip })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/code/verify', { body: { email, code }, ip })).status, 401, 'code à usage unique');
  // un email existant avec mot de passe peut aussi utiliser le code ; la réponse est identique
  const u = await t.user();
  const again = await t.call('POST', '/api/auth/code/request', { body: { email: u.email }, ip: t.newIp() });
  assert.deepEqual(again.body, { ok: true });
  // l'administrateur n'a pas de connexion par code : aucun code émis
  const before = t.devOutbox.length;
  assert.equal((await t.call('POST', '/api/auth/code/request', { body: { email: 'owner@test.invalid' }, ip: t.newIp() })).status, 200);
  assert.equal(t.devOutbox.slice(before).filter((m) => m.to === 'owner@test.invalid' && /connexion Velyra/.test(m.subject ?? '')).length, 0);
  // compte créé sans mot de passe : la connexion classique échoue
  assert.equal((await t.call('POST', '/api/auth/login', { body: { email, password: 'Motdepasse123' }, ip })).status, 401);
});

// ------------------------------------------------------------------ Stripe
const SECRET = 'whsec_test_secret';
const sign = (raw: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;

test('Stripe : signature de webhook (schéma v1, tolérance, falsification)', async () => {
  const { stripeSignatureValid } = await import('../server/providers/stripe.js');
  const raw = '{"a":1}';
  assert.equal(stripeSignatureValid(raw, sign(raw), SECRET), true);
  assert.equal(stripeSignatureValid(raw, sign(raw, 'autre'), SECRET), false);
  assert.equal(stripeSignatureValid(raw + ' ', sign(raw), SECRET), false);
  assert.equal(stripeSignatureValid(raw, sign(raw, SECRET, Math.floor(Date.now() / 1000) - 3600), SECRET), false, 'trop ancienne');
  assert.equal(stripeSignatureValid(raw, '', SECRET), false);
  assert.equal(stripeSignatureValid(raw, sign(raw).replace('v1=', 'v0='), SECRET), false, 'seul v1 est accepté');
});

test('Stripe : requête de création de session et lecture du statut', async () => {
  const { config } = await import('../server/config.js');
  const { StripePayments } = await import('../server/providers/stripe.js');
  config.stripe.secretKey = 'sk_test_x';
  const calls: { url: string; init: any }[] = [];
  let session: any = { id: 'cs_1', url: 'https://checkout.stripe.test/c/cs_1', payment_status: 'unpaid', status: 'open', amount_total: 800, currency: 'eur' };
  const s = new StripePayments(t.db, (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(session), { status: 200 }); }) as any);
  const base = { ref: 'VLYTEST1', amount: 8, currency: 'EUR', description: 'Velyra Pro 30 jours', channels: 'CREDIT_CARD' as const, notifyUrl: 'x', returnUrl: 'https://app.test/payment/return?ref=VLYTEST1', customerEmail: 'a@b.test' };
  const r = await s.init({ ...base, method: 'sepa' });
  assert.equal(r.paymentUrl, session.url); assert.equal(r.token, 'cs_1');
  const f = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_x');
  assert.equal(f.get('mode'), 'payment'); assert.equal(f.get('client_reference_id'), 'VLYTEST1');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '800', 'centimes');
  assert.equal(f.get('line_items[0][price_data][currency]'), 'eur');
  assert.deepEqual(f.getAll('payment_method_types[]'), ['sepa_debit']);
  await s.init({ ...base, method: 'apple_pay' });
  assert.deepEqual(new URLSearchParams(calls[1].init.body).getAll('payment_method_types[]'), ['card']);
  // vérification (nécessite l'identifiant de session enregistré avec le paiement)
  await t.db.run(`INSERT INTO payments (id,user_id,plan_code,amount,currency,country,region,provider,channel,provider_ref,provider_token,status,created_at,updated_at) VALUES ('p1',NULL,'pro',8,'EUR','FR','europe','stripe','sepa','VLYTEST1','cs_1','pending',$1,$1)`, [new Date().toISOString()]);
  assert.equal((await s.verify('VLYTEST1')).status, 'PENDING');
  session = { ...session, payment_status: 'paid', status: 'complete' };
  const v = await s.verify('VLYTEST1'); assert.equal(v.status, 'ACCEPTED'); assert.equal(v.amount, 8); assert.equal(v.currency, 'EUR');
  session = { ...session, payment_status: 'unpaid', status: 'expired' };
  assert.equal((await s.verify('VLYTEST1')).status, 'REFUSED');
  assert.equal((await s.verify('INCONNUE')).status, 'REFUSED');
  config.stripe.secretKey = '';
});

test('Stripe : parcours Europe complet (euro, SEPA, webhook signé → abonnement), montant incohérent refusé', async () => {
  const { config } = await import('../server/config.js');
  const { StripePayments } = await import('../server/providers/stripe.js');
  config.stripe.secretKey = 'sk_test_x'; config.stripe.webhookSecret = SECRET;
  let amountTotal = 800;
  const fake = (async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/v1/checkout/sessions') && init?.method === 'POST') { const id = `cs_${Math.random().toString(36).slice(2, 8)}`; return new Response(JSON.stringify({ id, url: `https://checkout.stripe.test/${id}` })); }
    return new Response(JSON.stringify({ id: 'x', payment_status: 'paid', status: 'complete', amount_total: amountTotal, currency: 'eur' }));
  }) as any;
  t.app.stripe = new StripePayments(t.db, fake);
  try {
    const u = await t.user({ country: 'FR' });
    const plans = await t.call('GET', '/api/plans?country=FR', { ip: u.ip });
    assert.equal(plans.body.currency, 'EUR');
    assert.equal(plans.body.plans.find((p: any) => p.code === 'pro').price.amount, 8);
    for (const id of ['sepa', 'apple_pay', 'google_pay', 'card']) assert.equal(plans.body.methods.find((m: any) => m.id === id)?.available, true, id);
    // Afrique de l'Ouest : inchangé (CinetPay/démo, pas Stripe)
    const ci = await t.call('GET', '/api/plans?country=CI', { ip: u.ip }); assert.equal(ci.body.currency, 'XOF');

    const co = await t.call('POST', '/api/payments/checkout', { body: { planCode: 'pro', country: 'FR', method: 'sepa' }, token: u.token, ip: u.ip });
    assert.equal(co.status, 200, JSON.stringify(co.body)); assert.equal(co.body.currency, 'EUR'); assert.equal(co.body.provider, 'stripe');
    const row = await t.db.get<any>(`SELECT provider, amount, currency, status, provider_token FROM payments WHERE provider_ref=$1`, [co.body.ref]);
    assert.equal(row!.provider, 'stripe'); assert.equal(row!.status, 'pending'); assert.ok(row!.provider_token.startsWith('cs_'));

    const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: co.body.ref } } });
    const bad = await t.call('POST', '/api/webhooks/stripe', { body: JSON.parse(evt), headers: { 'stripe-signature': sign(evt, 'mauvais') }, ip: '198.51.100.20' });
    assert.equal(bad.status, 400);
    assert.equal((await t.db.get<any>(`SELECT status FROM payments WHERE provider_ref=$1`, [co.body.ref]))!.status, 'pending', 'signature invalide : aucun effet');
    const good = await t.call('POST', '/api/webhooks/stripe', { body: JSON.parse(evt), headers: { 'stripe-signature': sign(JSON.stringify(JSON.parse(evt))) }, ip: '198.51.100.20' });
    assert.equal(good.status, 200);
    assert.equal((await t.db.get<any>(`SELECT status FROM payments WHERE provider_ref=$1`, [co.body.ref]))!.status, 'succeeded');
    assert.equal((await t.call('GET', '/api/me', { token: u.token, ip: u.ip })).body.entitlements.platformAccess, true);
    // rejouer le webhook ne crédite pas deux fois
    await t.call('POST', '/api/webhooks/stripe', { body: JSON.parse(evt), headers: { 'stripe-signature': sign(JSON.stringify(JSON.parse(evt))) }, ip: '198.51.100.20' });
    assert.equal((await t.db.get<any>(`SELECT COUNT(*) AS n FROM wallet_ledger WHERE payment_id=(SELECT id FROM payments WHERE provider_ref=$1) AND kind='credit'`, [co.body.ref]))!.n, 1);

    // montant confirmé par Stripe différent du montant demandé → échec + signalement
    const u2 = await t.user({ country: 'DE' });
    amountTotal = 100;
    const co2 = await t.call('POST', '/api/payments/checkout', { body: { planCode: 'pro', country: 'DE', method: 'card' }, token: u2.token, ip: u2.ip });
    assert.equal(co2.body.provider, 'stripe');
    const s2 = await t.call('GET', `/api/payments/${co2.body.ref}`, { token: u2.token, ip: u2.ip });
    assert.equal(s2.body.status, 'failed');
    assert.equal((await t.call('GET', '/api/me', { token: u2.token, ip: u2.ip })).body.entitlements.platformAccess, false);
  } finally { config.stripe.secretKey = ''; config.stripe.webhookSecret = ''; t.app.stripe = undefined; }
});

test('sans Stripe : SEPA / Apple Pay / Google Pay indisponibles et refusés', async () => {
  const u = await t.user({ country: 'FR' });
  const plans = await t.call('GET', '/api/plans?country=FR', { ip: u.ip });
  assert.equal(plans.body.currency, 'USD');
  assert.equal(plans.body.methods.find((m: any) => m.id === 'sepa').available, false);
  const co = await t.call('POST', '/api/payments/checkout', { body: { planCode: 'pro', country: 'FR', method: 'apple_pay' }, token: u.token, ip: u.ip });
  assert.equal(co.status, 400); assert.equal(co.body.error.code, 'method_unavailable');
  assert.equal((await t.call('POST', '/api/webhooks/stripe', { body: {}, ip: t.newIp() })).status, 404);
});

// ------------------------------------------------------------------ OpenAI (API Responses)
test('OpenAI : requête Responses et lecture de la sortie (items de raisonnement ignorés)', async () => {
  const { config } = await import('../server/config.js');
  const { openai, llmChat, _setProvidersForTests } = await import('../server/services/llm.js');
  _setProvidersForTests(null);
  config.ai.openai.key = 'sk-test'; const realFetch = globalThis.fetch;
  let seen: any; let resp: any = { model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Bonjour ' }, { type: 'output_text', text: 'Franck' }] }], usage: { input_tokens: 11, output_tokens: 7 } };
  globalThis.fetch = (async (url: any, init: any) => { seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }; return new Response(JSON.stringify(resp)); }) as any;
  try {
    const r = await openai.call([{ role: 'system', content: 'Sois bref.' }, { role: 'user', content: 'Salut' }], { model: 'gpt-6-luna' });
    assert.equal(r.text, 'Bonjour Franck'); assert.equal(r.tokensIn, 11); assert.equal(r.tokensOut, 7);
    assert.equal(seen.url, 'https://api.openai.com/v1/responses');
    assert.equal(seen.headers.authorization, 'Bearer sk-test');
    assert.equal(seen.body.model, 'gpt-6-luna'); assert.equal(seen.body.instructions, 'Sois bref.');
    assert.deepEqual(seen.body.input, [{ role: 'user', content: 'Salut' }]);
    assert.ok(seen.body.max_output_tokens >= 2000); assert.equal(seen.body.store, false);
    assert.equal(config.ai.openai.model, 'gpt-6.1-sol', 'modèle par défaut du chat');
    // réponse tronquée sans texte → erreur (le routeur passe alors au fournisseur suivant)
    resp = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }] };
    await assert.rejects(() => openai.call([{ role: 'user', content: 'x' }]), /incomplète/);
    // routeur : OpenAI en échec → repli sur le fournisseur local
    const out = await llmChat([{ role: 'user', content: 'x' }], 'openai');
    assert.equal(out.provider, 'local');
  } finally { globalThis.fetch = realFetch; config.ai.openai.key = ''; }
});
