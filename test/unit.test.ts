import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { totpAt, verifyTotp, base32Encode, base32Decode } from '../server/lib/totp.js';
import { adminPasswordProblems, decrypt, encrypt, hashPassword, verifyPassword, userPasswordProblems } from '../server/lib/crypto.js';
import { hit, resetKey } from '../server/lib/ratelimit.js';
import { cinetpayToken, cinetpayTokenValid, cleanDescription } from '../server/providers/cinetpay.js';
import { chunkText, tokenize } from '../server/services/knowledge.js';
import { zScore } from '../server/services/insights.js';
import { parseCsv, analyzePosts, extractHashtags } from '../server/services/tiktok.js';
import { COUNTRIES, methodsFor } from '../server/data/regions.js';
import { normalizePhone } from '../server/lib/util.js';
import { assertSafeJsonStructure } from '../server/lib/waf.js';

test('TOTP : vecteurs de test RFC 6238 (SHA-1, 8 chiffres)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, 59_000, { digits: 8 }), '94287082');
  assert.equal(totpAt(secret, 1111111109_000, { digits: 8 }), '07081804');
  assert.equal(totpAt(secret, 1234567890_000, { digits: 8 }), '89005924');
  assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'));
});
test('TOTP : tolérance ±1 pas, rejet au-delà et des formats invalides', () => {
  const s = base32Encode(Buffer.from('secret-secret-secret'));
  const now = 1_700_000_000_000;
  assert.ok(verifyTotp(s, totpAt(s, now), now));
  assert.ok(verifyTotp(s, totpAt(s, now - 30_000), now));
  assert.ok(!verifyTotp(s, totpAt(s, now - 120_000), now));
  assert.ok(!verifyTotp(s, '12345', now));
  assert.ok(!verifyTotp(s, 'abcdef', now));
});
test('mots de passe : hachage salé, vérification, politique admin (16 car.)', async () => {
  const h1 = await hashPassword('Motdepasse123'), h2 = await hashPassword('Motdepasse123');
  assert.notEqual(h1, h2);
  assert.ok(await verifyPassword('Motdepasse123', h1));
  assert.ok(!(await verifyPassword('motdepasse123', h1)));
  assert.ok(!(await verifyPassword('x', null)));
  assert.ok(!h1.includes('Motdepasse123'));
  assert.deepEqual(adminPasswordProblems('Correct-Horse-Battery-42!'), []);
  assert.ok(adminPasswordProblems('Court1!').length > 0);
  assert.ok(adminPasswordProblems('sansmajuscule-1234567!').includes('une majuscule'));
  assert.ok(adminPasswordProblems('SansChiffre-Aucun-Ici!!').includes('un chiffre'));
  assert.ok(adminPasswordProblems('SansSpecial1234567890').includes('un caractère spécial'));
  assert.ok(userPasswordProblems('court').length > 0);
});
test('chiffrement AES-256-GCM : aller-retour, aléa, détection d\'altération', () => {
  const a = encrypt('0102030405'), b = encrypt('0102030405');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), '0102030405');
  const parts = a.split(':'); parts[3] = Buffer.from('xxxxxxxxxx').toString('base64');
  assert.throws(() => decrypt(parts.join(':')));
});
test('limiteur de débit : fenêtre glissante', () => {
  resetKey('t');
  assert.ok(hit('t', 2, 1000, 0).allowed); assert.ok(hit('t', 2, 1000, 10).allowed);
  const r = hit('t', 2, 1000, 20); assert.ok(!r.allowed); assert.ok(r.retryAfterSec >= 1);
  assert.ok(hit('t', 2, 1000, 1500).allowed);
});
test('CinetPay : jeton HMAC (ordre des champs de la documentation) et description nettoyée', () => {
  const body = { cpm_site_id: '1', cpm_trans_id: 'A', cpm_trans_date: 'd', cpm_amount: '100', cpm_currency: 'XOF', signature: 's', payment_method: 'OM', cel_phone_num: '0', cpm_phone_prefixe: '225', cpm_language: 'fr', cpm_version: 'v2', cpm_payment_config: 'SINGLE', cpm_page_action: 'PAYMENT', cpm_custom: '', cpm_designation: 'x', cpm_error_message: 'SUCCES' };
  const t = cinetpayToken(body, 'secret');
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.ok(cinetpayTokenValid(body, t, 'secret'));
  assert.ok(!cinetpayTokenValid({ ...body, cpm_amount: '1' }, t, 'secret'));
  assert.ok(!cinetpayTokenValid(body, undefined, 'secret'));
  assert.equal(cleanDescription('Pro #1 / 30_jours & plus $'), 'Pro 1 30 jours plus');
});
test('régions : pays, devises CinetPay, moyens par région', () => {
  assert.equal(COUNTRIES.CI.currency, 'XOF'); assert.equal(COUNTRIES.CM.currency, 'XAF'); assert.equal(COUNTRIES.CD.currency, 'CDF'); assert.equal(COUNTRIES.GN.currency, 'GNF');
  for (const c of Object.values(COUNTRIES)) assert.ok(['XOF', 'XAF', 'CDF', 'GNF', 'USD'].includes(c.currency));
  assert.deepEqual(methodsFor('west_africa').filter((m) => m.available).map((m) => m.id), ['wave', 'mtn', 'orange', 'moov', 'card']);
  assert.deepEqual(methodsFor('central_africa').map((m) => m.id), ['card']);
  const eu = methodsFor('europe');
  assert.ok(eu.find((m) => m.id === 'card')!.available); assert.ok(!eu.find((m) => m.id === 'sepa')!.available);
});
test('téléphone E.164', () => {
  assert.equal(normalizePhone('+225 01 02 03 04 05'), '+2250102030405');
  assert.throws(() => normalizePhone('0102030405'));
});
test('recherche : découpage et normalisation des accents', () => {
  assert.deepEqual(tokenize('Le Café à Abidjan'), ['cafe', 'abidjan']);
  const chunks = chunkText('Phrase une. '.repeat(200));
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 900));
});
test('insights : z-score', () => {
  assert.ok(zScore([5, 5, 6, 5, 4, 5, 5, 5, 6, 5, 4, 5, 5, 30]).z > 3);
  assert.ok(Math.abs(zScore([5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 5]).z) < 2);
});
test('TikTok : import CSV, hashtags, analyse basique et avancée', () => {
  const posts = parseCsv('date;legende;vues;likes;commentaires;partages;format;duree_s\n2026-01-05T18:00:00Z;Danse #abidjan #danse;1000;100;10;5;danse;20\n2026-01-12T18:00:00Z;Danse 2 #abidjan;3000;300;30;15;danse;25\n2026-01-13T09:00:00Z;Conseils #astuce;500;20;2;1;talk;45\n2026-01-20T09:00:00Z;Conseils 2 #astuce;700;30;3;2;talk;50');
  assert.equal(posts.length, 4);
  assert.deepEqual(extractHashtags('A #Abidjan #abidjan #CI_225'), ['#abidjan', '#ci_225']);
  const rows = posts.map((p) => ({ posted_at: new Date(p.postedAt).toISOString(), caption: p.caption ?? '', hashtags: extractHashtags(p.caption ?? '').join(' '), views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, format: p.format ?? null, duration_s: p.durationS ?? null }));
  const basic = analyzePosts(rows);
  assert.equal(basic.advanced, null); assert.equal(basic.basic.posts, 4); assert.equal(basic.basic.topPosts[0].views, 3000);
  const adv = analyzePosts(rows, { advanced: true, country: 'CI', category: 'Danse' }).advanced as any;
  assert.equal(adv.byFormat[0].key, 'danse');
  assert.equal(adv.topHashtags[0].hashtag, '#abidjan');
  assert.ok(adv.suggestedHashtags.items.includes('#cotedivoire'));
  assert.equal(adv.marketTrends, null);
  assert.throws(() => parseCsv('a,b\n1,2'));
});

test('garde WAF (structure JSON) : pollution de prototype bloquée, texte libre légitime autorisé', () => {
  // `{ __proto__: … }` en syntaxe littérale d'objet ne crée pas une propriété propre (elle change juste le prototype cible) :
  // on passe par JSON.parse, comme le fait réellement la couche HTTP sur un corps de requête reçu du réseau.
  assert.throws(() => assertSafeJsonStructure(JSON.parse('{"__proto__":{"polluted":true}}')), /non autorisé/);
  assert.throws(() => assertSafeJsonStructure({ user: { constructor: { x: 1 } } }), /non autorisé/);
  assert.throws(() => assertSafeJsonStructure(JSON.parse('{"a":{"b":{"c":{"__proto__":1}}}}')), /non autorisé/);
  // profondeur et taille excessives (épuisement de ressources)
  let deep: any = 1; for (let i = 0; i < 20; i++) deep = { n: deep };
  assert.throws(() => assertSafeJsonStructure(deep), /imbriqué/);
  assert.throws(() => assertSafeJsonStructure({ list: Array.from({ length: 6000 }, (_, i) => i) }), /volumineux/);
  // le contenu libre (propre à un assistant IA : code, SQL, HTML dans un message) n'est jamais filtré sur sa VALEUR
  assert.doesNotThrow(() => assertSafeJsonStructure({ message: "<script>alert(1)</script> ; DROP TABLE users; -- explique-moi cette attaque", country: 'CI' }));
});
