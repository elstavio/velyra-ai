import http from 'node:http';
import { config } from './config.js';
import type { App } from './app.js';
import { Raw, clientIp, deviceHashFrom, readBody, sendJson, sendRaw, securityHeaders, serveStatic, type Req } from './lib/http.js';
import { HttpError, nowIso } from './lib/util.js';
import { hit } from './lib/ratelimit.js';
import { buildRouter } from './routes.js';
import { authenticate } from './services/auth.js';
import { isBlocked, looksLikeProbe, recordProbe, blockIp, logEvent, revokeSessionsForIp } from './services/security.js';
import { isHoneypot, springTrap } from './services/honeypot.js';
import { recordError } from './services/ops.js';

export function createHttpServer(app: App): http.Server {
  const router = buildRouter(app);
  const { db } = app;

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const ip = clientIp(req);
    const head = req.method === 'HEAD';
    const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
    const method = req.method ?? 'GET';
    let path = '/';
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      path = url.pathname;

      if (config.corsOrigin && path.startsWith('/api/')) {
        res.setHeader('access-control-allow-origin', config.corsOrigin);
        res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'authorization,content-type,x-device-id,x-api-key');
        res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
        if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      }
      if (isBlocked(ip)) {
        // Zero Trust / confinement : même si cette IP a été bloquée par une voie qui ne passe pas par blockIp()
        // (ex. insertion directe dans ip_blocks), toute session encore active sur cette IP est révoquée ici — pas
        // seulement « muette » tant que le blocage dure. Ainsi, si le blocage est levé plus tard, la session ne
        // redevient pas valide par la même occasion : il faut se reconnecter. Opération bon marché (sans effet si
        // déjà fait) : une requête SQL qui ne trouve rien à révoquer la deuxième fois.
        void revokeSessionsForIp(db, ip, 'IP bloquée : toute session active sur cette IP est révoquée par précaution');
        throw new HttpError(403, 'ip_blocked', 'Accès refusé');
      }

      // --- Anti-DDoS/DoS : rafale (fenêtre très courte) en plus du débit par minute. Une rafale massive
      // (bien au-delà d'un usage humain ou même d'un client légitime qui boucle) bloque l'IP directement.
      // Plafond de comptage large (bien au-delà du seuil autorisé) : une fois le seuil atteint, hit() normal
      // n'incrémenterait plus jamais le compteur (il refuserait d'empiler), ce qui empêcherait de jamais
      // détecter une rafale massive derrière le seuil — d'où un plafond de comptage distinct du seuil autorisé.
      const burst = hit(`burst:${ip}`, config.apiBurstPerIpPerSecond * 50, config.apiBurstWindowMs);
      if (burst.count > config.apiBurstPerIpPerSecond) {
        if (burst.count >= config.apiBurstPerIpPerSecond * 4 && !isBlocked(ip)) {
          await blockIp(db, ip, `Rafale anormale de requêtes (${burst.count} en ${config.apiBurstWindowMs}ms)`, { hours: 1 });
        } else {
          void logEvent(db, 'burst_rate_limited', 'low', { ip, detail: { count: burst.count, path } });
        }
        res.setHeader('retry-after', '2');
        throw new HttpError(429, 'rate_limited', 'Trop de requêtes, ralentissez.');
      }
      const rl = hit(`api:${ip}`, config.apiPerIpPerMinute, 60_000);
      if (!rl.allowed) { res.setHeader('retry-after', String(rl.retryAfterSec)); throw new HttpError(429, 'rate_limited', 'Trop de requêtes, ralentissez.'); }

      // --- Piège anti-intrusion : routes qui n'existent dans aucune interface légitime (voir services/honeypot.ts).
      if (isHoneypot(path)) {
        const trap = await springTrap(db, { method, path, params: {}, query: {}, body: {}, headers: req.headers, ip, ua: String(req.headers['user-agent'] ?? '').slice(0, 300), deviceHash: null, token: null });
        return sendJson(res, trap.status, trap.body, head, acceptEncoding);
      }
      if (looksLikeProbe(path)) { await recordProbe(db, ip, path); throw new HttpError(404, 'not_found', 'Introuvable'); }

      const m = router.match(method, path);
      if (m && m !== 'method') {
        const { route, params } = m;
        const auth = String(req.headers.authorization ?? '');
        const r: Req = {
          method, path, params, query: Object.fromEntries(url.searchParams), body: await readBody(req, path), headers: req.headers, ip,
          ua: String(req.headers['user-agent'] ?? '').slice(0, 300), deviceHash: deviceHashFrom(req.headers), token: auth.startsWith('Bearer ') ? auth.slice(7) : null,
        };
        if (route.auth !== 'none') {
          const a = await authenticate(db, r.token);
          if (!a) throw new HttpError(401, 'unauthorized', 'Authentification requise');
          if (route.auth === 'admin') {
            if (!a.session.is_admin || a.user.role !== 'admin' || !a.user.totp_enabled) throw new HttpError(403, 'forbidden', 'Accès administrateur requis');
            // Zero Trust : une session admin n'est jamais acceptée « par défaut » — elle est revérifiée À CHAQUE requête,
            // pas seulement à la connexion (le blocage d'IP lui-même est déjà traité plus haut, avant l'authentification,
            // et révoque aussi la session via revokeSessionsForIp — voir le bloc isBlocked(ip) en tête de requête).
            // Ici : l'empreinte d'appareil envoyée doit toujours correspondre à celle de l'ouverture de session — sinon
            // c'est le signe d'un jeton probablement volé/rejoué ailleurs, et la session est révoquée immédiatement
            // (confinement borné : seulement cette session, jamais une action sur les comptes ou l'argent).
            // Un simple changement de réseau (IP différente mais même appareil, ex. passage wifi -> 4G) n'est PAS bloqué
            // automatiquement — trop d'usages légitimes le provoquent — mais il est journalisé pour rester visible.
            if (r.deviceHash && a.session.device_hash && r.deviceHash !== a.session.device_hash) {
              await db.run(`UPDATE sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL`, [a.session.id, nowIso()]);
              await logEvent(db, 'admin_session_revoked_device_mismatch', 'critical', { ip, userId: a.user.id, detail: { sessionId: a.session.id, path } });
              throw new HttpError(401, 'unauthorized', 'Session invalidée : changement d\'appareil détecté. Reconnectez-vous.');
            }
            if (a.session.ip && a.session.ip !== ip) {
              void logEvent(db, 'admin_session_ip_changed', 'medium', { ip, userId: a.user.id, detail: { sessionId: a.session.id, previousIp: a.session.ip, path } });
            }
          } else {
            if (a.session.is_admin || a.user.role !== 'user') throw new HttpError(401, 'unauthorized', 'Authentification requise');
            if (a.user.status !== 'active' && route.pattern !== '/api/auth/logout') throw new HttpError(403, 'account_disabled', 'Compte suspendu ou révoqué');
          }
          r.user = a.user; r.session = a.session;
        }
        const out = await route.handler(r);
        if (out instanceof Raw) return sendRaw(res, out, acceptEncoding);
        return sendJson(res, 200, out ?? { ok: true }, head, acceptEncoding);
      }
      if (path.startsWith('/api/')) throw new HttpError(m === 'method' ? 405 : 404, m === 'method' ? 'method_not_allowed' : 'not_found', m === 'method' ? 'Méthode non autorisée' : 'Introuvable');
      if ((method === 'GET' || head) && serveStatic(path, res, head, acceptEncoding)) return;
      throw new HttpError(404, 'not_found', 'Introuvable');
    } catch (e: any) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader('connection', 'close'); // corps non lu : on ferme la connexion
        if (e.code === 'invalid_body') { // JSON malformé ou structure dangereuse (clé de pollution de prototype, imbrication excessive) : trace + comptage comme un sondage
          void logEvent(db, 'malformed_body_rejected', 'low', { ip, detail: { path } });
          void recordProbe(db, ip, `(corps invalide) ${path}`);
        }
        return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } }, false, acceptEncoding);
      }
      await recordError(db, e, `${method} ${path}`);
      if (!config.isProd) console.error(e);
      return sendJson(res, 500, { error: { code: 'internal', message: 'Erreur interne. L\'incident a été enregistré.' } }, false, acceptEncoding);
    }
  });

  // --- Anti-DoS au niveau connexion (slowloris : connexions ouvertes lentement, jamais terminées).
  server.headersTimeout = 15_000; // temps max pour recevoir les en-têtes complets
  server.requestTimeout = 30_000; // temps max pour traiter une requête entière
  server.keepAliveTimeout = 8_000; // ferme les connexions inactives plus vite qu'une attente indéfinie
  server.maxHeadersCount = 100;

  return server;
}
