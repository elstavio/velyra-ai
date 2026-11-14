import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
let sec: typeof import('../server/services/security.js');
before(async () => { t = await boot(); sec = await import('../server/services/security.js'); });
after(async () => { await t.close(); });

test('détection comportementale : 3 catégories de signaux distincts depuis la même IP en moins de 10 min -> blocage automatique + confinement de session (§23)', async () => {
  const ip = t.newIp();
  const u = await t.user(); // crée un compte et une session normale (IP différente)
  // On place artificiellement une session active sur l'IP suspecte, pour vérifier le confinement automatique.
  await t.db.run(`UPDATE sessions SET ip=$1 WHERE user_id=$2`, [ip, u.id]);
  const before = await t.db.get<any>(`SELECT revoked_at FROM sessions WHERE user_id=$1`, [u.id]);
  assert.equal(before.revoked_at, null);

  assert.equal(sec.isBlocked(ip), false);
  await sec.recordSecuritySignal(t.db, ip, 'probe');
  assert.equal(sec.isBlocked(ip), false, 'un seul signal ne suffit pas');
  await sec.recordSecuritySignal(t.db, ip, 'failed_login');
  assert.equal(sec.isBlocked(ip), false, 'deux signaux ne suffisent pas encore');
  await sec.recordSecuritySignal(t.db, ip, 'webauthn_failed');
  assert.equal(sec.isBlocked(ip), true, 'trois catégories distinctes -> blocage automatique');

  const row = await t.db.get<any>(`SELECT severity, detail FROM security_events WHERE type='correlated_threat_detected' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(row.severity, 'critical');
  assert.ok(JSON.parse(row.detail).kinds.length === 3);

  // Confinement borné : la session ouverte sur cette IP a été révoquée automatiquement (pas les autres sessions de l'utilisateur ailleurs).
  const after1 = await t.db.get<any>(`SELECT revoked_at FROM sessions WHERE user_id=$1`, [u.id]);
  assert.ok(after1.revoked_at, 'la session liée à l\'IP bloquée doit être révoquée');
  const me = await t.call('GET', '/api/me', { token: u.token, ip: u.ip });
  assert.equal(me.status, 401, 'le jeton de la session révoquée ne doit plus fonctionner');
});

test('détection comportementale : même IP, mais une seule catégorie répétée plusieurs fois -> pas de blocage par corrélation', async () => {
  const ip = t.newIp();
  for (let i = 0; i < 10; i++) await sec.recordSecuritySignal(t.db, ip, 'probe');
  assert.equal(sec.isBlocked(ip), false, 'la corrélation exige des catégories DIFFÉRENTES, pas la répétition d\'une seule');
});

test('les agents IA (Sentinelle & co) ne peuvent jamais exécuter une action sensible seuls : une proposition reste "pending" jusqu\'à une décision humaine explicite', async () => {
  const insights = await import('../server/services/insights.js');
  const before = await insights.listProposals(t.db, 'pending');
  // Même après un run complet, aucune proposition ne passe seule à "approved" : seule l'administration humaine peut le faire (route /api/admin/ai/:id/decision).
  await insights.runInsights(t.db);
  const after1 = await insights.listProposals(t.db, 'approved');
  assert.equal(after1.length, 0, 'aucune proposition ne doit être auto-approuvée par l\'IA');
  void before;
});
