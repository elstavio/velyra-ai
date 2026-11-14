// Audit IDOR (Insecure Direct Object Reference) : pour CHAQUE ressource identifiable par un id dans l'API,
// un utilisateur B authentifié ne doit jamais pouvoir lire, modifier ou supprimer une ressource appartenant à A
// en devinant ou en rejouant son identifiant. Ce fichier fixe ce contrat par un test automatisé, pour chaque
// route qui prend un :id — pas seulement pour celles déjà revues à la main — afin qu'une régression future
// (nouvelle route, oubli d'un filtre user_id) fasse immédiatement échouer la suite plutôt que d'être découverte
// en production.
import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const get = (u: { token: string; ip: string }, path: string) => t.call('GET', path, { token: u.token, ip: u.ip });
const del = (u: { token: string; ip: string }, path: string) => t.call('DELETE', path, { token: u.token, ip: u.ip });
const put = (u: { token: string; ip: string }, path: string, body?: unknown) => t.call('PUT', path, { body: body ?? {}, token: u.token, ip: u.ip });
const post = (u: { token: string; ip: string }, path: string, body?: unknown) => t.call('POST', path, { body: body ?? {}, token: u.token, ip: u.ip });

/** Un attaquant authentifié (B) ne doit jamais obtenir mieux qu'un 404 sur une ressource de la victime (A) —
 *  jamais un 200 avec les données de A, jamais un 403 qui confirmerait que l'id existe (fuite d'énumération). */
function assertNotFoundForOther(res: { status: number }, label: string) {
  assert.equal(res.status, 404, `${label} : un autre utilisateur ne doit obtenir qu'un 404 (obtenu : ${res.status})`);
}

test('IDOR — conversations : lecture, suppression, export', async () => {
  const a = await t.user(); const b = await t.user();
  const r = await post(a, '/api/chat', { message: 'Message privé de A' });
  const id = r.body.conversationId as string;
  assertNotFoundForOther(await get(b, `/api/conversations/${id}`), 'GET conversation');
  assertNotFoundForOther(await get(b, `/api/conversations/${id}/export`), 'export conversation');
  assertNotFoundForOther(await del(b, `/api/conversations/${id}`), 'DELETE conversation');
  assertNotFoundForOther(await post(b, '/api/chat', { message: 'x', conversationId: id }), 'POST chat sur conversation d\'autrui');
  // la victime, elle, garde un accès normal
  assert.equal((await get(a, `/api/conversations/${id}`)).status, 200);
});

test('IDOR — mémoires et documents : suppression et export', async () => {
  const a = await t.user(); const b = await t.user();
  const mem = await post(a, '/api/memories', { content: 'Secret de A' });
  assertNotFoundForOther(await del(b, `/api/memories/${mem.body.id}`), 'DELETE mémoire');

  const doc = await post(a, '/api/documents', { title: 'Doc de A', content: 'Contenu confidentiel suffisamment long pour passer la validation.' });
  assertNotFoundForOther(await get(b, `/api/documents/${doc.body.id}/export`), 'export document');
  assertNotFoundForOther(await del(b, `/api/documents/${doc.body.id}`), 'DELETE document');
  assert.equal((await get(a, `/api/documents/${doc.body.id}/export`)).status, 200);
});

test('IDOR — sessions du compte : un autre utilisateur ne peut pas révoquer une session qui n\'est pas la sienne', async () => {
  const a = await t.user(); const b = await t.user();
  const sessions = await get(a, '/api/account/sessions');
  const sessionId = sessions.body.sessions[0].id as string;
  assertNotFoundForOther(await del(b, `/api/account/sessions/${sessionId}`), 'DELETE session');
});

test('IDOR — agents et workflows : lecture (via édition), modification, suppression, exécution', async () => {
  const a = await t.user(); const b = await t.user();
  const ag = await post(a, '/api/agents', { name: 'Agent de A', systemPrompt: 'Instructions privées de A' });
  assertNotFoundForOther(await put(b, `/api/agents/${ag.body.id}`, { name: 'Détourné', systemPrompt: 'Instructions de remplacement suffisamment longues' }), 'PUT agent');
  assertNotFoundForOther(await del(b, `/api/agents/${ag.body.id}`), 'DELETE agent');

  const wf = await post(a, '/api/workflows', { name: 'Workflow de A', steps: [{ type: 'prompt', prompt: 'Dis bonjour (étape de test)' }] });
  assertNotFoundForOther(await put(b, `/api/workflows/${wf.body.id}`, { name: 'Détourné', steps: [{ type: 'prompt', prompt: 'Étape de remplacement' }] }), 'PUT workflow');
  assertNotFoundForOther(await post(b, `/api/workflows/${wf.body.id}/run`, { input: {} }), 'POST run workflow');
  // Cette route ne vérifie pas la propriété du workflow lui-même : elle filtre directement workflow_runs par
  // (workflow_id, user_id). Comportement sûr tant que la liste reste bien vide pour B — vérifié ci-dessous.
  const runsAsB = await get(b, `/api/workflows/${wf.body.id}/runs`);
  assert.equal(runsAsB.status, 200); // la liste existe mais doit être vide — l'id du workflow d'autrui ne doit rien révéler
  assert.deepEqual(runsAsB.body.runs, []);
  assertNotFoundForOther(await del(b, `/api/workflows/${wf.body.id}`), 'DELETE workflow');
});

test('IDOR — clés d\'API : révocation', async () => {
  const a = await t.user(); const b = await t.user();
  const k = await post(a, '/api/keys', { name: 'Clé de A' });
  assertNotFoundForOther(await del(b, `/api/keys/${k.body.id}`), 'DELETE clé API');
});

test('IDOR — comptes TikTok : suppression, ajout de posts/instantanés, analyse, import', async () => {
  const a = await t.user(); const b = await t.user();
  const acc = await post(a, '/api/tiktok/accounts', { handle: '@compte_prive_a' });
  const id = acc.body.id as string;
  assertNotFoundForOther(await post(b, `/api/tiktok/accounts/${id}/snapshots`, { followers: 999 }), 'POST instantané TikTok');
  assertNotFoundForOther(await post(b, `/api/tiktok/accounts/${id}/posts`, { posts: [{ postedAt: new Date().toISOString(), views: 1, likes: 1, comments: 0, shares: 0 }] }), 'POST publications TikTok');
  assertNotFoundForOther(await post(b, `/api/tiktok/accounts/${id}/analyze`, {}), 'POST analyse TikTok');
  assertNotFoundForOther(await del(b, `/api/tiktok/accounts/${id}`), 'DELETE compte TikTok');
  assert.equal((await del(a, `/api/tiktok/accounts/${id}`)).status, 200); // la victime garde l'accès
});

test('IDOR — comptes et contenus sociaux (insérés directement en base, hors du parcours OAuth payant, pour isoler le filtrage par propriétaire)', async () => {
  const a = await t.user(); const b = await t.user();
  // B doit avoir l'offre « Social » active : sans cela, updateDraft()/publish() le rejetteraient avec 402 avant même
  // d'atteindre la vérification de propriété, ce qui masquerait un éventuel IDOR plutôt que de le tester réellement.
  await t.db.run(`INSERT INTO subscriptions (id,user_id,plan_code,payment_id,starts_at,ends_at,created_at) VALUES ($1,$2,'social_pro',$3,$4,$5,$4)`,
    [crypto.randomUUID(), b.id, crypto.randomUUID(), new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86_400_000).toISOString()]);
  const now = new Date().toISOString();
  const accId = crypto.randomUUID();
  await t.db.run(
    `INSERT INTO social_accounts (id,user_id,platform,external_id,display_name,access_enc,status,created_at,updated_at) VALUES ($1,$2,'tiktok','ext-a','Compte de A','x','active',$3,$3)`,
    [accId, a.id, now],
  );
  assertNotFoundForOther(await del(b, `/api/social/accounts/${accId}`), 'DELETE compte social');

  const contentId = crypto.randomUUID();
  await t.db.run(`INSERT INTO social_content (id,user_id,platform,kind,title,output,created_at) VALUES ($1,$2,'tiktok','caption','Titre de A','Texte privé de A',$3)`, [contentId, a.id, now]);
  assertNotFoundForOther(await del(b, `/api/social/content/${contentId}`), 'DELETE contenu social');

  const draftId = crypto.randomUUID();
  await t.db.run(
    `INSERT INTO social_posts (id,user_id,platform,kind,body,status,content_hash,created_at,updated_at) VALUES ($1,$2,'tiktok','caption','Brouillon privé de A','draft','hash123',$3,$3)`,
    [draftId, a.id, now],
  );
  assertNotFoundForOther(await get(b, `/api/social/drafts/${draftId}`), 'GET brouillon social');
  assertNotFoundForOther(await put(b, `/api/social/drafts/${draftId}`, { body: 'Détourné' }), 'PUT brouillon social');
  assertNotFoundForOther(await del(b, `/api/social/drafts/${draftId}`), 'DELETE brouillon social');
  assertNotFoundForOther(await post(b, `/api/social/drafts/${draftId}/publish`, {}), 'POST publication brouillon social');
});

test('IDOR — paiements : consultation du statut par référence', async () => {
  const a = await t.user(); const b = await t.user();
  const paymentId = crypto.randomUUID(); const ref = 'REF-' + crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  await t.db.run(
    `INSERT INTO payments (id,user_id,provider,provider_ref,plan_code,amount,currency,channel,country,region,status,created_at,updated_at) VALUES ($1,$2,'mock',$3,'pro',5000,'XOF','mobile_money','CI','west_africa','succeeded',$4,$4)`,
    [paymentId, a.id, ref, now],
  );
  assertNotFoundForOther(await get(b, `/api/payments/${ref}`), 'GET statut paiement d\'autrui');
  assert.equal((await get(a, `/api/payments/${ref}`)).status, 200);
});
