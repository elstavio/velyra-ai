import { config } from './config.js';
import type { App } from './app.js';
import { Router, html, redirect, text, Raw, type Req } from './lib/http.js';
import { HttpError, bad, forbidden, int, notFound, nowIso, parseJson, str } from './lib/util.js';
import { hit } from './lib/ratelimit.js';
import { safeEqual as safeEq } from './lib/crypto.js';
import { COUNTRIES, countryList, methodsFor } from './data/regions.js';
import * as auth from './services/auth.js';
import * as adminAuth from './services/adminAuth.js';
import * as admin from './services/admin.js';
import * as pay from './services/payments.js';
import * as payouts from './services/payouts.js';
import * as sec from './services/security.js';
import * as ops from './services/ops.js';
import * as aibudget from './services/aibudget.js';
import * as insights from './services/insights.js';
import * as ent from './services/entitlements.js';
import * as chat from './services/chat.js';
import * as know from './services/knowledge.js';
import * as studio from './services/studio.js';
import * as tiktok from './services/tiktok.js';
import * as social from './services/social.js';
import * as tokenSvc from './services/tokens.js';
import * as pub from './services/publishing.js';
import * as plus from './services/adminplus.js';
import * as webauthn from './services/webauthnSvc.js';
import * as integrity from './services/integrity.js';
import * as keys from './services/apikeys.js';
import * as extract from './services/extract.js';
import { cinetpayTokenValid } from './providers/cinetpay.js';
import { stripeSignatureValid } from './providers/stripe.js';
import * as sysagents from './services/sysagents.js';
import { MockPayments } from './providers/mock.js';
import { providerIds } from './services/llm.js';

const U = (r: Req) => r.user as auth.UserRow;
const providersOf = (app: App): pay.ProviderMap => ({ [app.payments.name]: app.payments, ...(app.stripe ? { stripe: app.stripe } : {}) });
const page = (r: Req) => Math.max(1, Number(r.query.page ?? 1) || 1);

export function buildRouter(app: App): Router {
  const { db } = app;
  const R = new Router();

  // ============================================================ public
  R.get('/api/health', 'none', async () => {
    const h = await ops.healthCheck(db);
    return { ok: h.ok, time: nowIso(), version: '1.0.0' };
  });
  // Filet de sécurité front (§2.8/§2.11) : un plantage React côté navigateur arrive ici plutôt que de disparaître
  // dans un écran blanc jamais journalisé. Aucune donnée sensible attendue ; tronqué par précaution malgré tout.
  R.post('/api/client-error', 'none', async (r) => {
    await ops.recordError(db, { message: `[client] ${str(r.body?.message, '').slice(0, 300)}`, stack: str(r.body?.stack, '').slice(0, 1500) }, str(r.body?.where, '').slice(0, 200) || 'client');
    return { ok: true };
  });
  R.get('/api/config', 'none', () => ({
    app: 'Velyra AI', trialTasks: config.trialTasks, googleClientId: config.googleClientId || null, appleClientId: config.appleClientId || null, emailCodeLogin: true, stripe: !!app.stripe, flags: config.flags,
    paymentProvider: app.payments.name, demoMode: app.payments.name === 'mock', aiProviders: providerIds(),
    countries: countryList(),
  }));
  R.get('/api/plans', 'none', (r) => pay.listPlans(db, r.query.country ? String(r.query.country).toUpperCase() : null));

  R.post('/api/auth/register', 'none', async (r) => { const u = await auth.register(db, r, r.body); return { ok: true, email: u.email, needsExtraVerification: u.needsExtraVerification }; });
  R.post('/api/auth/login', 'none', (r) => auth.login(db, r, r.body));
  R.post('/api/auth/google', 'none', (r) => auth.loginWithGoogle(db, r, r.body.credential));
  R.post('/api/auth/apple', 'none', (r) => auth.loginWithApple(db, r, r.body.idToken, r.body.nonce));
  R.post('/api/auth/code/request', 'none', async (r) => { await auth.requestLoginCode(db, r, r.body.email); return { ok: true }; });
  R.post('/api/auth/code/verify', 'none', (r) => auth.loginWithCode(db, r, r.body.email, r.body.code));
  R.post('/api/auth/forgot', 'none', async (r) => { await auth.requestPasswordReset(db, r, r.body.email); return { ok: true }; });
  R.post('/api/auth/reset', 'none', async (r) => { await auth.resetPassword(db, r, r.body); return { ok: true }; });

  // ============================================================ compte
  R.get('/api/me', 'user', async (r) => {
    const u = U(r);
    const e = await ent.getEntitlements(db, u);
    const country = u.country ? COUNTRIES[u.country] : null;
    return { user: auth.publicUser(u), entitlements: e, region: country?.region ?? null, currency: country?.currency ?? null,
      todo: [!u.email_verified && 'verify_email', !u.phone_verified && 'verify_phone', !u.country && 'set_country'].filter(Boolean) };
  });
  R.post('/api/auth/logout', 'user', async (r) => { await auth.revokeSession(db, U(r).id, r.session!.id); return { ok: true }; });
  R.post('/api/auth/verify-email', 'user', async (r) => { await auth.verifyEmail(db, U(r), r.body.code); return { ok: true }; });
  R.post('/api/auth/resend-email', 'user', async (r) => { await auth.resendEmailCode(db, U(r)); return { ok: true }; });
  R.post('/api/account/country', 'user', async (r) => {
    const c = String(r.body.country ?? '').toUpperCase();
    if (!COUNTRIES[c]) throw bad('invalid_country', 'Pays inconnu');
    await db.run(`UPDATE users SET country=$2, updated_at=$3 WHERE id=$1`, [U(r).id, c, nowIso()]);
    return { ok: true };
  });
  R.post('/api/account/phone/send', 'user', async (r) => { await auth.sendPhoneCode(db, U(r), r.body.phone); return { ok: true }; });
  R.post('/api/account/phone/verify', 'user', async (r) => { await auth.verifyPhoneCode(db, U(r), r.body.code); return { ok: true }; });
  R.get('/api/account/sessions', 'user', async (r) => ({ sessions: await auth.listSessions(db, U(r).id, r.session!.id) }));
  R.del('/api/account/sessions/:id', 'user', async (r) => { await auth.revokeSession(db, U(r).id, r.params.id); return { ok: true }; });
  R.post('/api/account/sessions/revoke-others', 'user', async (r) => { await auth.revokeAllSessions(db, U(r).id, r.session!.id); return { ok: true }; });
  R.post('/api/account/delete-code', 'user', async (r) => { await auth.requestAccountDeletionCode(db, U(r)); return { ok: true }; });
  R.post('/api/account/delete', 'user', async (r) => { await auth.deleteAccount(db, U(r), r.body); return { ok: true }; });
  R.get('/api/account/export', 'user', async (r) => {
    const id = U(r).id;
    const data = {
      exportedAt: nowIso(), profile: auth.publicUser(U(r)),
      tasks: await db.query(`SELECT kind,billing,status,created_at FROM tasks WHERE user_id=$1`, [id]),
      payments: await db.query(`SELECT provider_ref,plan_code,amount,currency,status,created_at FROM payments WHERE user_id=$1`, [id]),
      conversations: await db.query(`SELECT c.id,c.title,c.created_at FROM conversations c WHERE c.user_id=$1`, [id]),
      memories: await know.listMemories(db, id), documents: await know.listDocuments(db, id), agents: await db.query(`SELECT name,description,system_prompt FROM agents WHERE user_id=$1`, [id]),
      loginHistory: await db.query(`SELECT ip,user_agent,success,created_at FROM login_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [id]),
    };
    return new Raw(200, JSON.stringify(data, null, 2), { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="velyra-mes-donnees.json"' });
  });
  R.get('/api/tasks', 'user', async (r) => ({ tasks: await db.query(`SELECT id,kind,billing,status,created_at FROM tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [U(r).id, Math.min(500, int(r.query.limit ?? 50, 'limit', { min: 1, max: 500, optional: true }) || 50)]) }));

  // ============================================================ paiements
  R.post('/api/payments/checkout', 'user', (r) => pay.createCheckout(db, app.payments, U(r), r.body, app.stripe));
  R.get('/api/payments/history', 'user', async (r) => ({ payments: await db.query(`SELECT provider_ref,plan_code,amount,currency,status,channel,created_at,confirmed_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [U(r).id]) }));
  R.get('/api/payments/:ref', 'user', async (r) => {
    // Le navigateur interroge ; si la notification n'est pas encore arrivée on vérifie auprès de l'agrégateur (anti-latence).
    const s = await pay.paymentStatus(db, U(r).id, r.params.ref);
    if (s.status === 'pending') { try { await pay.processNotificationAuto(db, providersOf(app), r.params.ref); } catch { /* agrégateur injoignable */ } return pay.paymentStatus(db, U(r).id, r.params.ref); }
    return s;
  });

  const notifyHandler = async (r: Req) => {
    const rl = hit(`webhook:${r.ip}`, 120, 60_000);
    if (!rl.allowed) throw new HttpError(429, 'rate_limited', 'Trop de requêtes');
    const ref = String(r.body.cpm_trans_id ?? r.body.transaction_id ?? '');
    if (!ref) return { ok: true };
    if (app.payments.name === 'cinetpay' && !cinetpayTokenValid(r.body, String(r.headers['x-token'] ?? ''), config.cinetpay.secretKey))
      await sec.logEvent(db, 'webhook_token_mismatch', 'medium', { ip: r.ip, detail: { ref: ref.slice(0, 40) } }); // la décision repose sur la vérification serveur-à-serveur ci-dessous
    const out = await pay.processNotificationAuto(db, providersOf(app), ref);
    return { ok: true, result: out };
  };
  // Stripe : la signature est vérifiée sur le corps brut ; la décision repose de toute façon sur la lecture serveur-à-serveur de la session.
  R.post('/api/webhooks/stripe', 'none', async (r) => {
    const rl = hit(`webhook:${r.ip}`, 120, 60_000);
    if (!rl.allowed) throw new HttpError(429, 'rate_limited', 'Trop de requêtes');
    if (!app.stripe) throw notFound();
    const raw = String((r.body as any).__raw ?? '');
    if (!stripeSignatureValid(raw, String(r.headers['stripe-signature'] ?? ''), config.stripe.webhookSecret)) {
      await sec.logEvent(db, 'webhook_signature_invalid', 'medium', { ip: r.ip, detail: { provider: 'stripe' } });
      throw new HttpError(400, 'invalid_signature', 'Signature invalide');
    }
    const ref = String(r.body?.data?.object?.client_reference_id ?? r.body?.data?.object?.metadata?.ref ?? '');
    if (ref) await pay.processNotificationAuto(db, providersOf(app), ref);
    return { received: true };
  });
  R.post('/api/webhooks/cinetpay', 'none', notifyHandler);
  R.get('/api/webhooks/cinetpay', 'none', () => ({ ok: true }));
  R.post('/api/webhooks/cinetpay-transfer', 'none', async (r) => {
    const rl = hit(`webhook:${r.ip}`, 120, 60_000);
    if (!rl.allowed) throw new HttpError(429, 'rate_limited', 'Trop de requêtes');
    void payouts.processPayouts(db, app.payouts).catch(() => undefined); // la notification n'est qu'un déclencheur : le statut est relu chez l'agrégateur
    return { ok: true };
  });
  R.get('/api/webhooks/cinetpay-transfer', 'none', () => ({ ok: true }));
  // Confirmation obligatoire par email avant toute exécution d'un retrait (automatique ou lancé depuis l'admin).
  R.get('/api/payouts/confirm/:token', 'none', async (r) => {
    const res = await payouts.confirmPayout(db, r.params.token, r.ip);
    return html(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Confirmation de retrait — Velyra AI</title>
<body style="font-family:system-ui;max-width:480px;margin:12vh auto;padding:0 16px;text-align:center">
<h2>${res.ok ? '✅ Confirmation' : '⚠️ Lien invalide'}</h2><p>${res.message}</p></body>`);
  });
  const back = (r: Req) => redirect(`/#/paiement/retour/${encodeURIComponent(String(r.query.ref ?? ''))}`);
  R.get('/payment/return', 'none', back);
  R.post('/payment/return', 'none', (r) => new Raw(303, '', { location: back(r).headers.location }));

  // Passerelle de démonstration (désactivée dès que le vrai agrégateur est utilisé)
  if (app.payments instanceof MockPayments) {
    const mock = app.payments;
    R.get('/mock-pay/:ref', 'none', async (r) => {
      const v = await mock.verify(r.params.ref);
      if (v.raw === 'inconnu') throw notFound();
      const ref = r.params.ref.replace(/[^A-Z0-9]/gi, '');
      return html(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Paiement de démonstration</title>
<body style="font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 16px"><h2>Paiement de démonstration</h2><p>Aucune somme réelle ne sera prélevée.</p><p><b>${v.amount} ${v.currency}</b> — réf. ${ref}</p>
<form method=post action="/mock-pay/${ref}/accept"><button style="padding:12px 18px;font-size:16px">Simuler un paiement réussi</button></form><br>
<form method=post action="/mock-pay/${ref}/refuse"><button style="padding:12px 18px;font-size:16px">Simuler un échec</button></form></body>`);
    });
    const finish = (accept: boolean) => async (r: Req) => {
      await mock.setState(r.params.ref, accept ? 'ACCEPTED' : 'REFUSED');
      await pay.processNotification(db, mock, r.params.ref);
      return new Raw(303, '', { location: `/#/paiement/retour/${encodeURIComponent(r.params.ref)}` });
    };
    R.post('/mock-pay/:ref/accept', 'none', finish(true));
    R.post('/mock-pay/:ref/refuse', 'none', finish(false));
  }

  // ============================================================ conversations, mémoire, documents
  R.post('/api/chat', 'user', (r) => chat.chat(db, U(r), r.body));
  R.get('/api/conversations', 'user', async (r) => ({ conversations: await chat.listConversations(db, U(r).id) }));
  R.get('/api/conversations/:id', 'user', (r) => chat.getConversation(db, U(r).id, r.params.id));
  R.del('/api/conversations/:id', 'user', async (r) => { await chat.deleteConversation(db, U(r).id, r.params.id); return { ok: true }; });
  R.get('/api/conversations/:id/export', 'user', async (r) => {
    const c = await chat.getConversation(db, U(r).id, r.params.id);
    const txt = `${c.title || 'Conversation'} — Velyra AI\n${nowIso()}\n\n` + c.messages.map((m: any) => `${m.role === 'user' ? 'Vous' : 'Assistant'} (${m.created_at}) :\n${m.content}\n`).join('\n');
    return new Raw(200, txt, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="conversation-${r.params.id.slice(0, 8)}.txt"` });
  });

  const flag = (f: keyof typeof config.flags) => { if (!config.flags[f]) throw forbidden('Fonctionnalité désactivée', 'feature_disabled'); };
  R.get('/api/memories', 'user', async (r) => { flag('memory'); return { memories: await know.listMemories(db, U(r).id) }; });
  R.post('/api/memories', 'user', async (r) => { flag('memory'); return { id: await know.addMemory(db, U(r).id, r.body.content) }; });
  R.del('/api/memories/:id', 'user', async (r) => { await know.deleteMemory(db, U(r).id, r.params.id); return { ok: true }; });
  R.get('/api/documents', 'user', async (r) => {
    flag('documents');
    const limit = int(r.query.limit ?? 50, 'limit', { min: 1, max: 200, optional: true }) || 50;
    const offset = int(r.query.offset ?? 0, 'offset', { min: 0, optional: true }) || 0;
    return know.listDocuments(db, U(r).id, limit, offset);
  });
  R.post('/api/documents', 'user', async (r) => { flag('documents'); return know.addDocument(db, U(r).id, r.body.title, r.body.content, 'text'); });
  R.post('/api/documents/upload', 'user', async (r) => {
    flag('documents');
    const { text, kind } = await extract.extractFromUpload(r.body.mime, r.body.filename, r.body.dataBase64);
    return know.addDocument(db, U(r).id, r.body.title || r.body.filename || 'Document importé', text, kind);
  });
  R.del('/api/documents/:id', 'user', async (r) => { await know.deleteDocument(db, U(r).id, r.params.id); return { ok: true }; });
  R.get('/api/documents/:id/export', 'user', async (r) => {
    const d = await know.getDocumentText(db, U(r).id, r.params.id);
    return new Raw(200, d.text, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${d.title.replace(/[^\w.\-]+/g, '_')}.txt"` });
  });
  R.get('/api/search', 'user', async (r) => {
    flag('documents');
    const q = String(r.query.q ?? '');
    if (r.query.mode === 'semantic') {
      const sem = await know.semanticSearch(db, U(r).id, q);
      if (sem) return { engine: 'semantic-embeddings', hits: sem };
      // repli honnête : pas de fournisseur d'embeddings configuré, ou documents pas encore indexés
    }
    return { engine: 'bm25-lexical', hits: await know.searchDocuments(db, U(r).id, q), semanticAvailable: know.embeddingsAvailable() };
  });

  R.get('/api/agents', 'user', async (r) => ({ agents: await studio.listAgents(db, U(r).id) }));
  R.post('/api/agents', 'user', async (r) => ({ id: await studio.saveAgent(db, U(r).id, r.body) }));
  R.put('/api/agents/:id', 'user', async (r) => ({ id: await studio.saveAgent(db, U(r).id, r.body, r.params.id) }));
  R.del('/api/agents/:id', 'user', async (r) => { await studio.deleteAgent(db, U(r).id, r.params.id); return { ok: true }; });
  R.get('/api/workflows', 'user', async (r) => ({ workflows: await studio.listWorkflows(db, U(r).id) }));
  R.post('/api/workflows', 'user', async (r) => ({ id: await studio.saveWorkflow(db, U(r).id, r.body) }));
  R.put('/api/workflows/:id', 'user', async (r) => ({ id: await studio.saveWorkflow(db, U(r).id, r.body, r.params.id) }));
  R.del('/api/workflows/:id', 'user', async (r) => { await studio.deleteWorkflow(db, U(r).id, r.params.id); return { ok: true }; });
  R.post('/api/workflows/:id/run', 'user', (r) => studio.runWorkflow(db, U(r), r.params.id, r.body.input));
  R.get('/api/workflows/:id/runs', 'user', async (r) => ({ runs: await studio.listRuns(db, U(r).id, r.params.id) }));
  R.get('/api/marketplace', 'user', async (r) => ({ listings: await studio.browseListings(db, r.query.q) }));
  R.get('/api/marketplace/mine', 'user', async (r) => ({ listings: await studio.myListings(db, U(r).id) }));
  R.post('/api/marketplace', 'user', async (r) => ({ id: await studio.publishListing(db, U(r), r.body) }));
  R.post('/api/marketplace/:id/install', 'user', (r) => studio.installListing(db, U(r), r.params.id));

  R.get('/api/keys', 'user', async (r) => { flag('publicApi'); return { keys: await keys.listApiKeys(db, U(r).id) }; });
  R.post('/api/keys', 'user', async (r) => { flag('publicApi'); return keys.createApiKey(db, U(r).id, r.body.name); });
  R.del('/api/keys/:id', 'user', async (r) => { await keys.revokeApiKey(db, U(r).id, r.params.id); return { ok: true }; });

  // ============================================================ API publique (clé d'API)
  const withKey = async (r: Req) => {
    flag('publicApi');
    const raw = String(r.headers['x-api-key'] ?? (String(r.headers.authorization ?? '').startsWith('Bearer ') ? String(r.headers.authorization).slice(7) : ''));
    const k = await keys.authenticateApiKey(db, raw || null);
    if (!k) throw new HttpError(401, 'invalid_api_key', 'Clé d\'API invalide');
    const rl = hit(`apikey:${k.keyId}`, 60, 60_000);
    if (!rl.allowed) throw new HttpError(429, 'rate_limited', `Limite : 60 requêtes/minute. Réessayez dans ${rl.retryAfterSec}s.`);
    return k.user;
  };
  R.get('/api/v1/me', 'none', async (r) => { const u = await withKey(r); return { email: u.email, entitlements: await ent.getEntitlements(db, u) }; });
  R.post('/api/v1/chat', 'none', async (r) => { const u = await withKey(r); return chat.chat(db, u, r.body); });
  R.get('/api/v1/search', 'none', async (r) => { const u = await withKey(r); return { hits: await know.searchDocuments(db, u.id, String(r.query.q ?? '')) }; });
  R.get('/api/v1/openapi.json', 'none', () => openApi());

  // ============================================================ Jetons
  R.get('/api/tokens', 'user', async (r) => ({ balance: await tokenSvc.getBalance(db, U(r).id), history: await tokenSvc.history(db, U(r).id) }));

  // ============================================================ Réseaux sociaux (offre « Social »)
  R.get('/api/social/platforms', 'user', async (r) => ({ platforms: social.platformStatus(), kinds: social.CONTENT_KINDS, entitled: (await ent.getEntitlements(db, U(r))).socialAccess }));
  R.post('/api/social/whatsapp/connect', 'user', async (r) => social.connectWhatsapp(db, U(r), r.body));
  R.post('/api/social/:platform/connect', 'user', async (r) => social.startConnect(db, U(r), r.params.platform));
  R.get('/api/social/callback/:platform', 'none', async (r) => redirect(await social.handleCallback(db, r.params.platform, r.query)));
  R.get('/api/social/accounts', 'user', async (r) => ({ accounts: await social.listAccounts(db, U(r)) }));
  R.post('/api/social/accounts/:id/sync', 'user', (r) => social.syncAccount(db, U(r), r.params.id));
  R.del('/api/social/accounts/:id', 'user', async (r) => { await social.disconnect(db, U(r), r.params.id); return { ok: true }; });
  R.post('/api/social/drafts/generate', 'user', (r) => pub.generateDrafts(db, U(r), r.body));
  R.post('/api/social/drafts', 'user', (r) => pub.createDraft(db, U(r), r.body));
  R.get('/api/social/drafts', 'user', async (r) => ({ drafts: await pub.listDrafts(db, U(r).id), killed: await pub.isKilled(db), statement: pub.STATEMENT }));
  R.get('/api/social/drafts/:id', 'user', (r) => pub.preview(db, U(r).id, r.params.id));
  R.put('/api/social/drafts/:id', 'user', (r) => pub.updateDraft(db, U(r), r.params.id, r.body));
  R.del('/api/social/drafts/:id', 'user', async (r) => { await pub.deleteDraft(db, U(r).id, r.params.id); return { ok: true }; });
  R.post('/api/social/drafts/:id/publish', 'user', (r) => pub.publish(db, U(r), r.params.id, r.body, r.ip));
  R.post('/api/social/content', 'user', (r) => social.createContent(db, U(r), r.body));
  R.get('/api/social/content', 'user', async (r) => ({ items: await social.listContent(db, U(r).id) }));
  R.del('/api/social/content/:id', 'user', async (r) => { await social.deleteContent(db, U(r).id, r.params.id); return { ok: true }; });

  // ============================================================ TikTok
  R.get('/api/tiktok/accounts', 'user', async (r) => ({ accounts: await tiktok.listAccounts(db, U(r).id) }));
  R.post('/api/tiktok/accounts', 'user', async (r) => ({ id: await tiktok.createAccount(db, U(r).id, r.body) }));
  R.del('/api/tiktok/accounts/:id', 'user', async (r) => { await tiktok.deleteAccount(db, U(r).id, r.params.id); return { ok: true }; });
  R.post('/api/tiktok/accounts/:id/snapshots', 'user', async (r) => { await tiktok.addSnapshot(db, U(r).id, r.params.id, r.body); return { ok: true }; });
  R.post('/api/tiktok/accounts/:id/posts', 'user', async (r) => {
    const posts = typeof r.body.csv === 'string' ? tiktok.parseCsv(r.body.csv) : r.body.posts;
    return { added: await tiktok.addPosts(db, U(r).id, r.params.id, posts) };
  });
  R.post('/api/tiktok/accounts/:id/analyze', 'user', (r) => tiktok.analyze(db, U(r), r.params.id, { advanced: r.body.advanced, tzOffsetMinutes: Number(r.body.tzOffsetMinutes ?? 0) || 0 }));
  R.post('/api/tiktok/accounts/:id/import-connected', 'user', (r) => tiktok.importFromConnected(db, U(r), r.params.id));

  // Planificateur externe (cron-job.org, UptimeRobot…) : réveille le serveur gratuit et garantit l'exécution quotidienne des agents.
  R.post('/api/cron/daily', 'none', async (r) => {
    const given = String(r.headers['x-cron-secret'] ?? '');
    if (!config.cronSecret || !safeEq(given, config.cronSecret)) throw new HttpError(401, 'unauthorized', 'Secret invalide');
    return sysagents.runDaily(db, 'cron');
  });

  // ============================================================ administration — authentification (§9)
  R.post('/api/admin/auth/login', 'none', (r) => adminAuth.adminLogin(db, r, r.body));
  R.post('/api/admin/auth/totp/setup', 'none', (r) => adminAuth.totpSetup(db, r.body.challengeId));
  R.post('/api/admin/auth/totp/confirm', 'none', (r) => adminAuth.totpConfirm(db, r.body.challengeId, r.body.code));
  R.post('/api/admin/auth/complete', 'none', (r) => adminAuth.afterEnroll(db, r, r.body.challengeId));
  R.post('/api/admin/auth/email-otp', 'none', async (r) => { await adminAuth.sendEmailOtp(db, r.body.challengeId); return { ok: true }; });
  R.post('/api/admin/auth/verify', 'none', (r) => adminAuth.adminVerify(db, r, r.body));
  R.post('/api/admin/auth/logout', 'admin', async (r) => { await auth.revokeSession(db, U(r).id, r.session!.id); return { ok: true }; });

  // Clés de sécurité (passkeys / WebAuthn) — second facteur alternatif au code TOTP lors de la connexion admin.
  R.post('/api/admin/auth/webauthn/options', 'none', (r) => webauthn.authOptions(db, r.body.challengeId));
  R.post('/api/admin/auth/webauthn/verify', 'none', (r) => webauthn.authVerify(db, r, r.body.challengeId, r.body.credential));
  R.post('/api/admin/webauthn/register/options', 'admin', (r) => webauthn.registerOptions(db, U(r)));
  R.post('/api/admin/webauthn/register/verify', 'admin', (r) => webauthn.registerVerify(db, U(r), r.body.challengeId, r.body.name, r.body.credential));
  R.get('/api/admin/webauthn/credentials', 'admin', async (r) => ({ credentials: await webauthn.listCredentials(db, U(r).id) }));
  R.del('/api/admin/webauthn/credentials/:id', 'admin', async (r) => { await webauthn.deleteCredential(db, U(r).id, r.params.id); return { ok: true }; });

  // ============================================================ administration — tableau de bord (§10)
  R.get('/api/admin/me', 'admin', (r) => ({ email: U(r).email, sessionExpiresAt: r.session!.expires_at }));
  R.get('/api/admin/dashboard', 'admin', () => admin.dashboard(db));
  R.get('/api/admin/users', 'admin', (r) => admin.listUsers(db, { query: r.query.q, status: r.query.status, page: page(r) }));
  R.post('/api/admin/users/:id/status', 'admin', async (r) => { await admin.setUserStatus(db, U(r).id, r.params.id, String(r.body.status), String(r.body.reason ?? '')); return { ok: true }; });
  R.get('/api/admin/fraud', 'admin', async (r) => ({ reports: await admin.listFraud(db, r.query.status ?? 'open') }));
  R.post('/api/admin/fraud', 'admin', async (r) => ({ id: await admin.reportFraud(db, U(r).id, String(r.body.userId), String(r.body.reason ?? '')) }));
  R.post('/api/admin/fraud/:id/review', 'admin', async (r) => { await admin.reviewFraud(db, U(r).id, r.params.id, r.body); return { ok: true }; });
  R.get('/api/admin/payments', 'admin', async (r) => ({ payments: await admin.listPayments(db, r.query.status, r.query.flagged === '1') }));
  R.get('/api/admin/wallet', 'admin', async () => ({ ...(await admin.walletOverview(db)), accounts: await payouts.listAccounts(db) }));
  R.post('/api/admin/payout-accounts', 'admin', async (r) => { const id = await payouts.saveAccount(db, r.body); await admin.audit(db, U(r).id, 'payout_account_saved', id); return { id }; });
  R.post('/api/admin/payout-accounts/:id/primary', 'admin', async (r) => { await payouts.setPrimary(db, r.params.id); return { ok: true }; });
  R.del('/api/admin/payout-accounts/:id', 'admin', async (r) => { await payouts.deleteAccount(db, r.params.id); await admin.audit(db, U(r).id, 'payout_account_deleted', r.params.id); return { ok: true }; });
  R.post('/api/admin/payouts/:id/release', 'admin', async (r) => { await payouts.releasePayout(db, r.params.id, U(r).id); return { ok: true }; });
  R.post('/api/admin/payouts/run', 'admin', async () => payouts.processPayouts(db, app.payouts));
  R.get('/api/admin/plans', 'admin', () => pay.listPlans(db, null));
  R.put('/api/admin/plans/:code/price', 'admin', async (r) => { await admin.setPlanPrice(db, U(r).id, r.params.code, String(r.body.currency), Number(r.body.amount)); return { ok: true }; });
  R.get('/api/admin/reports/revenue', 'admin', async (r) => {
    const s = await admin.revenueSeries(db, Math.min(365, Number(r.query.days ?? 90) || 90));
    return r.query.format === 'csv' ? new Raw(200, admin.revenueCsv(s.daily), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="revenus.csv"' }) : s;
  });

  // sécurité (§8)
  R.get('/api/admin/security/events', 'admin', async (r) => ({
    events: await db.query(`SELECT id,type,severity,ip,user_id,detail,created_at,hash FROM security_events ${r.query.severity ? 'WHERE severity=$1' : ''} ORDER BY created_at DESC LIMIT 200`, r.query.severity ? [r.query.severity] : []) }));
  R.get('/api/admin/security/verify-chain', 'admin', () => sec.verifyChain(db));
  R.get('/api/admin/security/evidence', 'admin', async (r) => {
    const events = await db.query(`SELECT * FROM security_events WHERE created_at >= $1 ORDER BY created_at`, [String(r.query.from ?? '1970-01-01')]);
    return new Raw(200, JSON.stringify({ exportedAt: nowIso(), chainVerification: await sec.verifyChain(db), events }, null, 2), { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="preuves-securite.json"' });
  });
  R.get('/api/admin/security/blocks', 'admin', async () => ({ blocks: await db.query(`SELECT ip,reason,permanent,created_at,expires_at,created_by FROM ip_blocks ORDER BY created_at DESC`) }));
  R.post('/api/admin/security/blocks', 'admin', async (r) => { const ip = str(r.body.ip, 'ip', { max: 45 }); await sec.blockIp(db, ip, String(r.body.reason ?? 'blocage manuel').slice(0, 200), { permanent: r.body.permanent === true, by: U(r).id }); await admin.audit(db, U(r).id, 'ip_block', ip); return { ok: true }; });
  R.post('/api/admin/security/blocks/remove', 'admin', async (r) => { await sec.unblockIp(db, str(r.body.ip, 'ip', { max: 45 })); await admin.audit(db, U(r).id, 'ip_unblock', String(r.body.ip)); return { ok: true }; });
  R.get('/api/admin/security/overview', 'admin', () => plus.securityOverview(db));
  R.post('/api/admin/security/honeypot/purge', 'admin', (r) => plus.purgeHoneypotNow(db, U(r).id));
  R.get('/api/admin/security/secrets', 'admin', () => plus.secretsOverview(db));
  R.post('/api/admin/security/secrets/:key/rotated', 'admin', (r) => plus.declareSecretRotated(db, U(r).id, r.params.key));
  R.get('/api/admin/sessions', 'admin', async () => ({ sessions: await db.query(`SELECT s.id,s.ip,s.user_agent,s.is_admin,s.created_at,s.last_seen_at,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.revoked_at IS NULL AND s.expires_at > $1 ORDER BY s.last_seen_at DESC LIMIT 200`, [nowIso()]) }));
  R.post('/api/admin/sessions/:id/revoke', 'admin', async (r) => { await db.run(`UPDATE sessions SET revoked_at=$2 WHERE id=$1`, [r.params.id, nowIso()]); await admin.audit(db, U(r).id, 'session_revoked', r.params.id); return { ok: true }; });
  R.get('/api/admin/logins', 'admin', async () => ({ logins: await db.query(`SELECT id,email,ip,user_agent,success,reason,created_at FROM login_logs ORDER BY created_at DESC LIMIT 200`) }));

  // IA d'analyse (§6) et exploitation (§7)
  R.get('/api/admin/ai', 'admin', async (r) => ({
    proposals: await insights.listProposals(db, r.query.status),
    runs: await db.query(`SELECT id,started_at,finished_at,anomalies,proposals_created FROM ai_runs ORDER BY started_at DESC LIMIT 10`),
    notice: "Analyse statistique d'agrégats anonymes (moyennes/écarts-types glissants, ratios). Aucune proposition n'est appliquée sans votre validation.",
  }));
  R.post('/api/admin/ai/run', 'admin', async () => { const { metrics, ...rest } = await insights.runInsights(db); return rest; });
  R.post('/api/admin/ai/:id/decision', 'admin', async (r) => { await insights.decideProposal(db, U(r).id, r.params.id, r.body.decision); return { ok: true }; });
  // Agents IA système (5 agents + superviseur)
  R.get('/api/admin/agents', 'admin', () => sysagents.overview(db));
  R.post('/api/admin/agents/run', 'admin', async (r) => { await admin.audit(db, U(r).id, 'agents_run_all', 'all'); return sysagents.runDaily(db, 'manual'); });
  R.post('/api/admin/agents/:name/run', 'admin', async (r) => { await admin.audit(db, U(r).id, 'agent_run', r.params.name); return sysagents.runOne(db, r.params.name, 'manual'); });
  // ---- renforts du tableau de bord : contrôles, jetons, réseaux/publications, finances, fiche utilisateur, exports
  R.get('/api/admin/integrity', 'admin', () => integrity.integritySummary(db));
  R.post('/api/admin/integrity/run', 'admin', async (r) => { await admin.audit(db, U(r).id, 'integrity_run', 'all'); return integrity.runIntegrity(db, 'manual'); });
  R.get('/api/admin/tokens', 'admin', () => plus.tokensOverview(db));
  R.post('/api/admin/tokens/adjust', 'admin', (r) => plus.adjustTokens(db, U(r).id, r.body));
  R.get('/api/admin/social', 'admin', () => plus.socialOverview(db));
  R.post('/api/admin/social/kill', 'admin', (r) => plus.setKill(db, U(r).id, r.body?.on === true));
  R.get('/api/admin/users/:id/overview', 'admin', (r) => plus.userOverview(db, r.params.id));
  R.get('/api/admin/finance', 'admin', (r) => plus.finance(db, Number(r.query.days ?? 30)));
  R.get('/api/admin/export/:kind', 'admin', async (r) => { const e = await plus.exportCsv(db, r.params.kind); await admin.audit(db, U(r).id, 'export_csv', r.params.kind); return new Raw(200, e.csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${e.name}"` }); });
  R.get('/api/admin/system', 'admin', async () => ({
    health: await ops.healthCheck(db), monitor: await ops.selfMonitor(db),
    errors: await db.query(`SELECT id,message,route,created_at FROM error_log ORDER BY created_at DESC LIMIT 30`),
    backups: await ops.listBackups(db), uptimeSec: Math.round(process.uptime()), aiProviders: providerIds(),
    aiBudget: await aibudget.todayUsage(db),
    payment: { provider: app.payments.name, payout: app.payouts.name },
  }));
  R.post('/api/admin/system/backup', 'admin', async (r) => { const b = await ops.createBackup(db); await admin.audit(db, U(r).id, 'backup_created', b.id); return { id: b.id, bytes: b.bytes }; });
  R.get('/api/admin/system/backups/:name', 'admin', (r) => {
    try { return new Raw(200, ops.backupFile(r.params.name), { 'content-type': r.params.name.endsWith('.enc') ? 'application/octet-stream' : 'application/gzip', 'content-disposition': `attachment; filename="${r.params.name.replace(/[^\w.\-]/g, '')}"` }); } catch { throw notFound(); }
  });
  R.post('/api/admin/system/heal', 'admin', () => ops.selfHeal(db));
  R.get('/api/admin/audit', 'admin', async () => ({ audit: await db.query(`SELECT id,actor_id,action,target,detail,created_at FROM audit_log ORDER BY created_at DESC LIMIT 200`) }));
  R.get('/api/admin/marketplace', 'admin', async (r) => ({ listings: await studio.adminListings(db, r.query.status ?? 'pending') }));
  R.post('/api/admin/marketplace/:id/moderate', 'admin', async (r) => { await studio.moderateListing(db, U(r).id, r.params.id, r.body.decision); return { ok: true }; });

  void int; void parseJson; void methodsFor; void text;
  return R;
}

function openApi() {
  const sec = [{ ApiKey: [] }];
  return {
    openapi: '3.0.3', info: { title: 'Velyra AI — API publique', version: '1.0.0', description: 'Chaque appel de chat consomme une tâche (essai gratuit ou abonnement). Limite : 60 requêtes/minute et par clé.' },
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
    paths: {
      '/api/v1/me': { get: { summary: 'Profil et droits', security: sec, responses: { 200: { description: 'OK' } } } },
      '/api/v1/chat': { post: { summary: 'Envoyer un message à l\'IA', security: sec, requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, conversationId: { type: 'string' }, agentId: { type: 'string' }, useDocuments: { type: 'boolean' } } } } } }, responses: { 200: { description: 'Réponse' }, 402: { description: 'Essais épuisés' } } } },
      '/api/v1/search': { get: { summary: 'Recherche dans vos documents (BM25 lexical)', security: sec, parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    },
  };
}
