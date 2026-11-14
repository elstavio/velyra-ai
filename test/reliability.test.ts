import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const post = (u: { token: string; ip: string }, path: string, body?: unknown) => t.call('POST', path, { body: body ?? {}, token: u.token, ip: u.ip });

test('coupe-circuit de dépense IA : au-delà du budget quotidien, les réponses basculent en mode démonstration sans appeler le fournisseur payant (§1.3)', async () => {
  const { _setProvidersForTests } = await import('../server/services/llm.js');
  const { config } = await import('../server/config.js');
  const oldBudget = config.ai.dailyTokenBudget;
  let paidCalls = 0;
  // Un faux fournisseur « payant » qui consomme beaucoup de jetons à chaque appel.
  _setProvidersForTests([{ id: 'openai', configured: () => true, model: () => 'test', call: async () => { paidCalls++; return { text: 'Réponse coûteuse', model: 'test', tokensIn: 400, tokensOut: 400 }; } } as any]);
  config.ai.dailyTokenBudget = 500; // dépassé dès le premier appel (800 jetons)
  try {
    const u = await t.user();
    const a = await post(u, '/api/chat', { message: 'Première question' });
    assert.equal(a.status, 200);
    assert.equal(paidCalls, 1, 'le premier appel doit effectivement solliciter le fournisseur, pour mesurer sa consommation réelle');
    const b = await post(u, '/api/chat', { message: 'Deuxième question', conversationId: a.body.conversationId });
    assert.equal(b.status, 200);
    assert.equal(paidCalls, 1, 'le budget étant dépassé après le premier appel, le second ne doit plus solliciter le fournisseur payant');
    assert.match(b.body.reply, /[Bb]udget IA quotidien atteint/);
  } finally { _setProvidersForTests(null); config.ai.dailyTokenBudget = oldBudget; }
});

test('plantage front : /api/client-error journalise l\'incident, consultable par un administrateur (§2.8/§2.11)', async () => {
  const r = await t.call('POST', '/api/client-error', { body: { message: 'TypeError: x is not a function', stack: 'at Chat (app1.tsx:1)', where: '/app/chat' } });
  assert.equal(r.status, 200);
  const a = await t.admin();
  const sys = await t.call('GET', '/api/admin/system', { token: a.token, ip: a.ip, headers: { 'x-device-id': 'dev-admin-0123456789abcdef' } });
  assert.equal(sys.status, 200);
  assert.ok(sys.body.errors.some((e: any) => String(e.message).includes('TypeError: x is not a function')), 'l\'erreur signalée par le navigateur doit apparaître dans le journal d\'erreurs admin');
  assert.ok('aiBudget' in sys.body, 'le tableau de bord admin expose l\'usage du budget IA du jour');
});

test('documents : pagination — limite respectée, total correct, « charger plus » fonctionne (§3.14)', async () => {
  const u = await t.user();
  for (let i = 0; i < 7; i++) await post(u, '/api/documents', { title: `Doc ${i}`, content: `Contenu suffisant pour le document numéro ${i} afin de passer la validation.` });
  const page1 = await t.call('GET', '/api/documents?limit=3&offset=0', { token: u.token, ip: u.ip });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.documents.length, 3);
  assert.equal(page1.body.total, 7);
  const page2 = await t.call('GET', '/api/documents?limit=3&offset=3', { token: u.token, ip: u.ip });
  assert.equal(page2.body.documents.length, 3);
  const page1Ids = new Set(page1.body.documents.map((d: any) => d.id));
  assert.ok(page2.body.documents.every((d: any) => !page1Ids.has(d.id)), 'la deuxième page ne doit pas répéter les documents de la première');
});

test('réponses HTTP compressées (gzip) au-delà d\'un certain poids, quand le client l\'accepte (§3.15)', async () => {
  const u = await t.user();
  for (let i = 0; i < 20; i++) await post(u, '/api/documents', { title: `Doc ${i}`, content: `Contenu suffisant pour le document numéro ${i} afin de passer la validation du serveur.` });
  const r = await t.call('GET', '/api/documents?limit=200', { token: u.token, ip: u.ip, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
});
