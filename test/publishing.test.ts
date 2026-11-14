import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
let PUB: typeof import('../server/services/publishing.js');
before(async () => { t = await boot(); PUB = await import('../server/services/publishing.js'); });
after(async () => { PUB._setFetcher(null); await t.close(); });

const post = (u: any, path: string, body?: unknown) => t.call('POST', path, { body: body ?? {}, token: u.token, ip: u.ip });
const get = (u: any, path: string) => t.call('GET', path, { token: u.token, ip: u.ip });
const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
async function social() {
  const u = await t.user();
  await t.db.run(`INSERT INTO subscriptions (id,user_id,plan_code,payment_id,starts_at,ends_at,created_at) VALUES ($1,$2,'social_pro',$3,$4,$5,$4)`, [crypto.randomUUID(), u.id, crypto.randomUUID(), new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86_400_000).toISOString()]);
  return u;
}
async function account(u: any, platform: string, externalId: string) {
  const id = crypto.randomUUID(); const { encrypt } = await import('../server/lib/crypto.js');
  await t.db.run(`INSERT INTO social_accounts (id,user_id,platform,external_id,display_name,access_enc,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7)`, [id, u.id, platform, externalId, `${platform}-cible`, encrypt('tok_' + platform), new Date().toISOString()]);
  return id;
}
const OK = { authorize: true, verified: true };

test('brouillon : exige l\'offre Social, contrôle plateforme/URL/destinataire, calcule l\'empreinte', async () => {
  const free = await t.user();
  assert.equal((await post(free, '/api/social/drafts', { platform: 'facebook', body: 'Bonjour' })).status, 402);
  const u = await social(); const fb = await account(u, 'facebook', 'P1');
  const d = await post(u, '/api/social/drafts', { platform: 'facebook', accountId: fb, body: 'Promo pagnes wax -10 % ce week-end', link: 'https://boutique.example/pagnes' });
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.status, 'draft'); assert.match(d.body.contentHash, /^[0-9a-f]{64}$/); assert.equal(d.body.createdBy, 'user');
  assert.equal((await post(u, '/api/social/drafts', { platform: 'facebook', body: 'x', link: 'http://non-securise.example' })).status, 400);
  assert.equal((await post(u, '/api/social/drafts', { platform: 'inconnue', body: 'x' })).status, 400);
  assert.equal((await post(u, '/api/social/drafts', { platform: 'whatsapp', body: 'x', recipient: '12' })).status, 400);
  assert.equal((await post(u, '/api/social/drafts', { platform: 'instagram', body: 'x'.repeat(2300) })).status, 400, 'légende trop longue');
  const other = await social(); assert.equal((await post(other, '/api/social/drafts', { platform: 'facebook', accountId: fb, body: 'vol de compte' })).status, 404);
});

test('Facebook : publication UNIQUEMENT après deux confirmations + empreinte exacte ; aucun appel réseau sinon', async () => {
  const u = await social(); const fb = await account(u, 'facebook', 'PAGE42'); const calls: any[] = [];
  PUB._setFetcher((async (url: any, init: any) => { calls.push({ url: String(url), init }); return J({ id: 'PAGE42_999' }); }) as any);
  const d = (await post(u, '/api/social/drafts', { platform: 'facebook', accountId: fb, body: 'Texte A' })).body; const url = `/api/social/drafts/${d.id}/publish`;
  // sans confirmations / une seule / valeurs non booléennes / mauvaise empreinte
  for (const b of [{}, { authorize: true }, { verified: true }, { authorize: true, verified: 'true', contentHash: d.contentHash }, { ...OK }, { ...OK, contentHash: 'abc' }, { authorize: false, verified: true, contentHash: d.contentHash }]) {
    const r = await post(u, url, b); assert.ok([400, 409].includes(r.status), JSON.stringify(b) + r.status);
  }
  assert.equal(calls.length, 0, 'aucun appel vers la plateforme sans double validation');
  assert.equal((await t.db.get<any>(`SELECT status FROM social_posts WHERE id=$1`, [d.id]))!.status, 'draft');
  // le contenu change après affichage : l'ancienne empreinte est refusée
  const edited = (await t.call('PUT', `/api/social/drafts/${d.id}`, { body: { body: 'Texte B modifié' }, token: u.token, ip: u.ip })).body;
  assert.notEqual(edited.contentHash, d.contentHash);
  const stale = await post(u, url, { ...OK, contentHash: d.contentHash }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'content_changed'); assert.equal(calls.length, 0);
  // validation correcte
  const ok = await post(u, url, { ...OK, contentHash: edited.contentHash });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, 'published'); assert.equal(ok.body.remoteId, 'PAGE42_999');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/PAGE42/feed');
  const f = calls[0].init.body as URLSearchParams; assert.equal(f.get('message'), 'Texte B modifié'); assert.equal(f.get('access_token'), 'tok_facebook');
  // audit : la validation est journalisée avec l'empreinte, la déclaration et l'IP
  const ap = await t.db.get<any>(`SELECT * FROM post_approvals WHERE post_id=$1`, [d.id]); assert.equal(ap.content_hash, edited.contentHash); assert.equal(ap.outcome, 'published'); assert.match(ap.statement, /vérifié qu'il est exactement celui/);
  // pas de double publication (rejeu) ni d'édition après publication
  assert.equal((await post(u, url, { ...OK, contentHash: edited.contentHash })).status, 409); assert.equal(calls.length, 1);
  assert.equal((await t.call('PUT', `/api/social/drafts/${d.id}`, { body: { body: 'après coup' }, token: u.token, ip: u.ip })).status, 409);
  assert.equal((await t.call('DELETE', `/api/social/drafts/${d.id}`, { token: u.token, ip: u.ip })).status, 409);
  // un autre utilisateur ne peut pas publier ce brouillon
  const other = await social(); assert.equal((await post(other, url, { ...OK, contentHash: edited.contentHash })).status, 404);
});

test('échec de la plateforme : statut « failed », erreur claire, AUCUNE nouvelle tentative automatique, nouvelle validation requise', async () => {
  const u = await social(); const fb = await account(u, 'facebook', 'PX'); let n = 0;
  PUB._setFetcher((async () => { n++; return n === 1 ? J({ error: { message: '(#200) Permissions error', code: 200 } }, 403) : J({ id: 'PX_1' }); }) as any);
  const d = (await post(u, '/api/social/drafts', { platform: 'facebook', accountId: fb, body: 'Test échec' })).body;
  const r = await post(u, `/api/social/drafts/${d.id}/publish`, { ...OK, contentHash: d.contentHash }); assert.equal(r.status, 502); assert.match(r.body.error.message, /Rien n'a été republié automatiquement/);
  assert.equal(n, 1); const pv = (await get(u, `/api/social/drafts/${d.id}`)).body; assert.equal(pv.status, 'failed'); assert.match(pv.error, /Permissions/);
  const again = await post(u, `/api/social/drafts/${d.id}/publish`, { ...OK, contentHash: pv.contentHash }); assert.equal(again.body.status, 'published'); assert.equal(n, 2);
  assert.equal((await t.db.get<any>(`SELECT COUNT(*) AS n FROM post_approvals WHERE post_id=$1`, [d.id]))!.n, 2, 'chaque tentative a sa propre validation');
});

test('Instagram : image JPEG publique obligatoire, conteneur puis publication ; WhatsApp : consentement du destinataire en plus', async () => {
  const u = await social(); const ig = await account(u, 'instagram', 'IG7'); const wa = await account(u, 'whatsapp', '555000111'); const calls: any[] = [];
  PUB._setFetcher((async (url: any, init: any) => { calls.push({ url: String(url), init }); const s = String(url); return s.endsWith('/media') ? J({ id: 'CONT1' }) : s.endsWith('/media_publish') ? J({ id: 'MEDIA1' }) : J({ messages: [{ id: 'wamid.1' }] }); }) as any);
  const noImg = (await post(u, '/api/social/drafts', { platform: 'instagram', accountId: ig, body: 'Sans image' })).body;
  const r0 = await post(u, `/api/social/drafts/${noImg.id}/publish`, { ...OK, contentHash: noImg.contentHash }); assert.equal(r0.status, 502); assert.equal(calls.length, 0);
  const d = (await post(u, '/api/social/drafts', { platform: 'instagram', accountId: ig, body: 'Nouvelle collection', imageUrl: 'https://cdn.example/photo.jpg' })).body;
  const r1 = await post(u, `/api/social/drafts/${d.id}/publish`, { ...OK, contentHash: d.contentHash }); assert.equal(r1.body.remoteId, 'MEDIA1');
  assert.deepEqual(calls.map((c) => c.url), ['https://graph.facebook.com/v26.0/IG7/media', 'https://graph.facebook.com/v26.0/IG7/media_publish']);
  assert.equal((calls[0].init.body as URLSearchParams).get('image_url'), 'https://cdn.example/photo.jpg'); assert.equal((calls[1].init.body as URLSearchParams).get('creation_id'), 'CONT1');
  calls.length = 0;
  const w = (await post(u, '/api/social/drafts', { platform: 'whatsapp', accountId: wa, body: 'Votre commande est prête.', recipient: '+225 07 00 00 00 01' })).body; assert.equal(w.recipient, '2250700000001'); assert.equal(w.needsRecipientConsent, true);
  const nc = await post(u, `/api/social/drafts/${w.id}/publish`, { ...OK, contentHash: w.contentHash }); assert.equal(nc.status, 400); assert.equal(nc.body.error.code, 'recipient_consent_required'); assert.equal(calls.length, 0);
  const ok = await post(u, `/api/social/drafts/${w.id}/publish`, { ...OK, recipientConsent: true, contentHash: w.contentHash }); assert.equal(ok.status, 200);
  const sent = JSON.parse(calls[0].init.body); assert.equal(sent.to, '2250700000001'); assert.equal(sent.type, 'text'); assert.equal(sent.messaging_product, 'whatsapp'); assert.equal(calls[0].init.headers.authorization, 'Bearer tok_whatsapp');
});

test('TikTok / YouTube : validation enregistrée mais aucune publication automatique (copie manuelle)', async () => {
  const u = await social(); const calls: any[] = []; PUB._setFetcher((async (url: any) => { calls.push(String(url)); return J({}); }) as any);
  const d = (await post(u, '/api/social/drafts', { platform: 'tiktok', body: 'Légende TikTok #abidjan' })).body; assert.equal(d.manualOnly, true);
  assert.equal((await post(u, `/api/social/drafts/${d.id}/publish`, { authorize: true, contentHash: d.contentHash })).status, 400);
  const r = await post(u, `/api/social/drafts/${d.id}/publish`, { ...OK, contentHash: d.contentHash }); assert.equal(r.body.status, 'manual_done'); assert.equal(calls.length, 0);
});

test('agent Rédacteur : crée uniquement des brouillons, jamais de publication, consomme une tâche ; coupe-circuit administrateur', async () => {
  const { _setProvidersForTests } = await import('../server/services/llm.js'); let sys = '';
  _setProvidersForTests([{ id: 'local', configured: () => true, call: async (m: any[]) => { sys = m[0].content; return { text: '{"posts":[{"title":"V1","body":"Texte un"},{"title":"V2","body":"Texte deux"}]}', provider: 'local', model: 't', tokensIn: 1, tokensOut: 1 }; } } as any]);
  const calls: any[] = []; PUB._setFetcher((async (url: any) => { calls.push(String(url)); return J({ id: 'x' }); }) as any);
  try {
    const u = await social(); const fb = await account(u, 'facebook', 'PK');
    const r = await post(u, '/api/social/drafts/generate', { platform: 'facebook', accountId: fb, topic: 'Ouverture de ma boutique', count: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.drafts.length, 2); assert.ok(r.body.drafts.every((x: any) => x.status === 'draft' && x.createdBy === 'agent'));
    assert.match(sys, /Tu ne publies JAMAIS/); assert.equal(calls.length, 0);
    assert.equal((await t.db.get<any>(`SELECT COUNT(*) AS n FROM social_posts WHERE user_id=$1 AND status <> 'draft'`, [u.id]))!.n, 0);
    // texte libre non JSON → un brouillon unique
    _setProvidersForTests([{ id: 'local', configured: () => true, call: async () => ({ text: 'Juste un texte', provider: 'local', model: 't' }) } as any]);
    assert.equal((await post(u, '/api/social/drafts/generate', { platform: 'facebook', topic: 'Autre sujet' })).body.drafts[0].body, 'Juste un texte');
    // coupe-circuit : plus aucune publication
    await t.db.run(`INSERT INTO settings (key,value) VALUES ('kill.publish','1')`);
    const d = r.body.drafts[0]; const k = await post(u, `/api/social/drafts/${d.id}/publish`, { ...OK, contentHash: d.contentHash }); assert.equal(k.status, 503); assert.equal(calls.length, 0);
    await t.db.run(`DELETE FROM settings WHERE key='kill.publish'`);
  } finally { _setProvidersForTests(null); }
});

test('la clé d\'API publique ne permet aucune publication', async () => {
  const u = await social(); const k = await post(u, '/api/keys', { name: 'test' }); const key = k.body.key ?? k.body.token ?? k.body.apiKey;
  const r = await t.call('POST', '/api/social/drafts', { body: { platform: 'facebook', body: 'x' }, headers: { 'x-api-key': String(key) }, ip: t.newIp() });
  assert.equal(r.status, 401);
});
