import { boot } from './helpers.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let t: Awaited<ReturnType<typeof boot>>;
let sec: typeof import('../server/services/security.js');
before(async () => { t = await boot(); sec = await import('../server/services/security.js'); });
after(async () => { await t.close(); });

test('Zero Trust : une session admin est revérifiée à chaque requête, pas seulement à la connexion — changement d\'appareil = révocation immédiate (§24)', async () => {
  const a = await t.admin('dev-admin-aaaaaaaaaaaaaaaa', '198.51.100.21');
  const ok = await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip, device: a.device });
  assert.equal(ok.status, 200);

  const hijacked = await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip, device: 'dev-pirate-bbbbbbbbbbbbbbbb' });
  assert.equal(hijacked.status, 401);
  assert.equal(hijacked.body.error.code, 'unauthorized');

  // Même avec le bon appareil, la session est désormais révoquée : aucune requête ultérieure ne doit plus passer.
  const after1 = await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip, device: a.device });
  assert.equal(after1.status, 401);

  const ev = await t.db.get<any>(`SELECT * FROM security_events WHERE type='admin_session_revoked_device_mismatch' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(ev.severity, 'critical');
});

test('Zero Trust : si l\'IP de la session admin devient bloquée en cours de session, la session est révoquée sans attendre une nouvelle connexion (§24)', async () => {
  const a = await t.admin('dev-admin-cccccccccccccccc', '198.51.100.22');
  const ok = await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip, device: a.device });
  assert.equal(ok.status, 200);

  // Simule un blocage d'IP décidé indépendamment (ex. autre mécanisme) sans passer par blockIp() :
  // vérifie que la revérification PAR REQUÊTE (et non seulement au moment du blocage) détecte et agit.
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await t.db.run(`INSERT INTO ip_blocks (ip,reason,permanent,created_at,expires_at,created_by) VALUES ($1,'test direct',0,$2,$3,'test')`, [a.ip, new Date().toISOString(), future]);
  await sec.loadBlocks(t.db);
  assert.equal(sec.isBlocked(a.ip), true);

  // Le blocage d'IP est refusé tôt, avant même l'authentification (comme pour n'importe quelle route) :
  const refused = await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip, device: a.device });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'ip_blocked');

  // Et la session elle-même a été révoquée en conséquence (pas seulement « muette » tant que le blocage dure) :
  // si le blocage était levé plus tard, le jeton ne redeviendrait pas valable pour autant.
  const sessions = await t.db.query<any>(`SELECT revoked_at FROM sessions WHERE ip=$1`, [a.ip]);
  assert.ok(sessions.length > 0 && sessions.every((s) => s.revoked_at), 'toute session sur cette IP doit être révoquée');
  await sec.unblockIp(t.db, a.ip);
  const afterUnblock = await t.call('GET', '/api/admin/me', { token: a.token, ip: a.ip, device: a.device });
  assert.equal(afterUnblock.status, 401, 'même après la levée du blocage, l\'ancien jeton ne doit plus fonctionner');
});

test('Zero Trust : un simple changement de réseau (IP différente, même appareil) est journalisé mais ne révoque pas la session à lui seul', async () => {
  const a = await t.admin('dev-admin-dddddddddddddddd', '198.51.100.23');
  const otherIp = t.newIp();
  const r = await t.call('GET', '/api/admin/me', { token: a.token, ip: otherIp, device: a.device });
  assert.equal(r.status, 200, 'un changement de réseau seul ne doit pas bloquer un administrateur légitime');
  const ev = await t.db.get<any>(`SELECT * FROM security_events WHERE type='admin_session_ip_changed' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(ev.severity, 'medium');
});
