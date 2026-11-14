import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

export const ADMIN_EMAIL = 'owner@test.invalid';
export const ADMIN_PASSWORD = 'Correct-Horse-Battery-42!';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'velyra-test-'));
process.env.SQLITE_PATH = ':memory:';
process.env.JOBS_ENABLED = 'false';
process.env.TRUST_PROXY_HOPS = '1';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.PAYOUT_PROVIDER = 'mock';
process.env.ALLOW_MOCK_PROVIDERS = 'true';
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.ADMIN_INITIAL_PASSWORD = ADMIN_PASSWORD;
process.env.OWNER_NOTIFY_EMAIL = ADMIN_EMAIL;
process.env.APP_URL = 'http://localhost:3999';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.APPLE_CLIENT_ID = 'test.velyra.service';
process.env.AI_DEFAULT_PROVIDER = 'local';

export interface Res { status: number; body: any; headers: Headers }

export async function boot() {
  const { createApp } = await import('../server/index.js');
  const { createHttpServer } = await import('../server/server.js');
  const { bootstrapAdmin } = await import('../server/services/adminAuth.js');
  const { devOutbox } = await import('../server/services/notify.js');
  const app = await createApp();
  await bootstrapAdmin(app.db);
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ipCounter = 10;
  const newIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function call(method: string, path: string, o: { body?: unknown; token?: string; ip?: string; device?: string; headers?: Record<string, string>; form?: boolean } = {}): Promise<Res> {
    const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? '203.0.113.7', ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.device) headers['x-device-id'] = o.device;
    let body: string | undefined;
    if (o.body !== undefined) {
      if (o.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.body as any).toString(); }
      else { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const t = await r.text();
    let j: any = t; try { j = JSON.parse(t); } catch { /* texte */ }
    return { status: r.status, body: j, headers: r.headers };
  }

  const lastCode = (to: string) => {
    for (let i = devOutbox.length - 1; i >= 0; i--) {
      const m = devOutbox[i];
      if (m.to === to) { const c = /\b(\d{6})\b/.exec(m.body); if (c) return c[1]; }
    }
    throw new Error(`aucun code pour ${to}`);
  };

  let n = 0;
  /** Crée un utilisateur complet : email vérifié (+ téléphone vérifié si demandé). Retourne {token, email, ip, id}. */
  async function user(o: { phone?: string | false; country?: string; password?: string } = {}) {
    const ip = newIp();
    const email = `u${++n}-${Math.random().toString(36).slice(2, 6)}@test.invalid`;
    const password = o.password ?? 'Motdepasse123';
    let r = await call('POST', '/api/auth/register', { body: { email, password, country: o.country ?? 'CI' }, ip });
    if (r.status !== 200) throw new Error('register ' + JSON.stringify(r.body));
    r = await call('POST', '/api/auth/login', { body: { email, password }, ip });
    const token = r.body.token as string;
    await call('POST', '/api/auth/verify-email', { body: { code: lastCode(email) }, token, ip });
    if (o.phone !== false) {
      const phone = o.phone ?? `+22507${String(10_000_000 + n * 7919).slice(0, 8)}`;
      const s = await call('POST', '/api/account/phone/send', { body: { phone }, token, ip });
      if (s.status !== 200) throw new Error('phone/send ' + JSON.stringify(s.body));
      const v = await call('POST', '/api/account/phone/verify', { body: { code: lastCode(phone) }, token, ip });
      if (v.status !== 200) throw new Error('phone/verify ' + JSON.stringify(v.body));
    }
    const me = await call('GET', '/api/me', { token, ip });
    return { token, email, ip, password, id: me.body.user.id as string };
  }

  /** Connexion administrateur complète (mot de passe + 2FA + code email si nouvel appareil). */
  let knownSecret: string | undefined;
  async function admin(device = 'dev-admin-0123456789abcdef', ip = '198.51.100.9', totpSecret?: string) {
    totpSecret ??= knownSecret;
    const { totpAt } = await import('../server/lib/totp.js');
    let r = await call('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, device, ip });
    if (r.status !== 200) throw new Error('admin login ' + JSON.stringify(r.body));
    const cid = r.body.challengeId as string;
    let secret = totpSecret, recovery: string[] | undefined;
    let result: any;
    if (r.body.steps.includes('totp_enroll')) {
      const s = await call('POST', '/api/admin/auth/totp/setup', { body: { challengeId: cid }, device, ip });
      secret = s.body.secret;
      const c = await call('POST', '/api/admin/auth/totp/confirm', { body: { challengeId: cid, code: totpAt(secret!, Date.now()) }, device, ip });
      if (c.status !== 200) throw new Error('totp confirm ' + JSON.stringify(c.body));
      recovery = c.body.recoveryCodes;
      result = (await call('POST', '/api/admin/auth/complete', { body: { challengeId: cid }, device, ip })).body;
    } else {
      result = (await call('POST', '/api/admin/auth/verify', { body: { challengeId: cid, step: 'totp', code: totpAt(secret!, Date.now()) }, device, ip })).body;
    }
    if (!result.done && result.remaining?.includes('email_otp')) {
      await call('POST', '/api/admin/auth/email-otp', { body: { challengeId: cid }, device, ip });
      result = (await call('POST', '/api/admin/auth/verify', { body: { challengeId: cid, step: 'email_otp', code: lastCode(ADMIN_EMAIL) }, device, ip })).body;
    }
    if (!result.done) throw new Error('admin non terminé ' + JSON.stringify(result));
    knownSecret = secret;
    return { token: result.token as string, secret: secret!, recovery, device, ip, challengeId: cid };
  }

  return { app, db: app.db, call, user, admin, lastCode, newIp, devOutbox, close: async () => { server.close(); await app.db.close(); } };
}
