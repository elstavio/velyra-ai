import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../config.js';
import { sha256 } from './crypto.js';
import { HttpError } from './util.js';
import { assertSafeJsonStructure } from './waf.js';

export interface AuthedUser {
  id: string; email: string; role: string; status: string; country: string | null;
  email_verified: number; phone: string | null; phone_verified: number; trials_used: number;
  totp_enabled: number; created_at: string;
}
export interface SessionInfo { id: string; is_admin: number; created_at: string; expires_at: string; ip: string | null; device_hash: string | null }

export interface Req {
  method: string; path: string; params: Record<string, string>; query: Record<string, string>;
  body: any; headers: IncomingMessage['headers']; ip: string; ua: string;
  deviceHash: string | null; token: string | null;
  user?: AuthedUser; session?: SessionInfo;
}
/** Réponse non-JSON (HTML, redirection…). */
export class Raw {
  constructor(public status: number, public body: string | Buffer, public headers: Record<string, string> = {}) {}
}
export const html = (body: string, status = 200) => new Raw(status, body, { 'content-type': 'text/html; charset=utf-8' });
export const redirect = (url: string) => new Raw(302, '', { location: url });
export const text = (body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) =>
  new Raw(200, body, { 'content-type': type, ...extra });

export type Auth = 'none' | 'user' | 'admin';
export type Handler = (r: Req) => Promise<unknown> | unknown;
interface Route { method: string; re: RegExp; keys: string[]; auth: Auth; handler: Handler; pattern: string }

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, auth: Auth, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, auth, handler, pattern });
  }
  get = (p: string, a: Auth, h: Handler) => this.add('GET', p, a, h);
  post = (p: string, a: Auth, h: Handler) => this.add('POST', p, a, h);
  put = (p: string, a: Auth, h: Handler) => this.add('PUT', p, a, h);
  del = (p: string, a: Auth, h: Handler) => this.add('DELETE', p, a, h);
  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    let pathHit = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathHit = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathHit ? 'method' : null;
  }
}

/** Adresse IP du client. N'accorde de confiance à X-Forwarded-For que pour le nombre de relais configuré. */
export function clientIp(req: IncomingMessage): string {
  const hops = config.trustProxyHops;
  let ip = req.socket.remoteAddress ?? '0.0.0.0';
  if (hops > 0) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length >= hops) ip = xff[xff.length - hops];
  }
  return ip.replace(/^::ffff:/, '');
}
export function ipPrefix(ip: string): string {
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':'); // IPv6 : /64
  return ip.split('.').slice(0, 3).join('.'); // IPv4 : /24
}

export function deviceHashFrom(h: IncomingMessage['headers']): string | null {
  const v = String(h['x-device-id'] ?? '');
  return /^[A-Za-z0-9-]{16,64}$/.test(v) ? sha256('device:' + v) : null;
}

// Limite par défaut volontairement basse (protection DoS) ; relevée uniquement pour la route d'upload de
// documents (fichier PDF/Word encodé en base64, ≈ 6 Mo bruts, voir services/extract.ts).
const MAX_BODY = 1_000_000;
const MAX_BODY_UPLOAD = 8_000_000;
export async function readBody(req: IncomingMessage, pathname?: string): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const limit = pathname === '/api/documents/upload' ? MAX_BODY_UPLOAD : MAX_BODY;
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Requête trop volumineuse');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const ct = String(req.headers['content-type'] ?? '');
  try {
    if (ct.includes('application/json')) { const o = JSON.parse(raw); assertSafeJsonStructure(o); if (o && typeof o === 'object') Object.defineProperty(o, '__raw', { value: raw, enumerable: false }); return o; }
    if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  } catch { throw new HttpError(400, 'invalid_body', 'Corps de requête invalide'); }
  return { _raw: raw };
}

export function securityHeaders(res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin-allow-popups');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('x-xss-protection', '0'); // obsolète/dangereux dans les navigateurs modernes ; désactivé explicitement, la CSP fait le travail
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client https://appleid.cdn-apple.com; connect-src 'self' https://appleid.apple.com; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/ https://appleid.apple.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (config.isProd) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

// Compression (§3.15) : au-delà d'un petit seuil, gzip les réponses texte si le client l'accepte. En dessous, l'en-tête
// gzip (18 octets) et le coût CPU ne valent pas le gain — on laisse la réponse telle quelle.
const COMPRESS_MIN_BYTES = 1024;
const acceptsGzip = (ae?: string | string[]) => String(Array.isArray(ae) ? ae.join(',') : ae ?? '').includes('gzip');

export function sendJson(res: ServerResponse, status: number, data: unknown, head = false, acceptEncoding?: string) {
  const body = JSON.stringify(data);
  const buf = Buffer.from(body, 'utf8');
  if (!head && buf.length >= COMPRESS_MIN_BYTES && acceptsGzip(acceptEncoding)) {
    const gz = gzipSync(buf);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': gz.length });
    return res.end(gz);
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(head ? undefined : buf);
}
export function sendRaw(res: ServerResponse, r: Raw, acceptEncoding?: string) {
  const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body, 'utf8');
  const type = r.headers['content-type'] ?? '';
  const compressible = /text\/|application\/json|application\/javascript|image\/svg/.test(type);
  if (compressible && buf.length >= COMPRESS_MIN_BYTES && acceptsGzip(acceptEncoding)) {
    const gz = gzipSync(buf);
    res.writeHead(r.status, { 'cache-control': 'no-store', ...r.headers, 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': gz.length });
    return res.end(gz);
  }
  res.writeHead(r.status, { 'cache-control': 'no-store', ...r.headers, 'content-length': buf.length });
  res.end(buf);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const TEXTY = new Set(['.html', '.js', '.css', '.json', '.svg', '.map', '.txt', '.webmanifest']);
/** Sert le build du frontend ; retourne false si aucun fichier index n'existe. */
export function serveStatic(pathname: string, res: ServerResponse, head: boolean, acceptEncoding?: string): boolean {
  const base = resolve(config.webDir);
  if (!existsSync(base)) return false;
  let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(base, rel);
  if (!resolve(file).startsWith(base + sep) && resolve(file) !== base) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) return false; // un fichier précis introuvable -> 404
    file = join(base, 'index.html'); // routes côté client (SPA)
    if (!existsSync(file)) return false;
  }
  const ext = extname(file);
  const immutable = /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const size = statSync(file).size;
  // Fichiers texte (JS/CSS/HTML du build…) : gzip à la volée si le client l'accepte, au-delà du seuil. Les
  // assets hachés sont déjà servis depuis le disque à chaque requête (pas de cache serveur) : coût CPU mesuré,
  // acceptable pour une appli mono-processus ; à déplacer vers un CDN/reverse proxy si le trafic grossit beaucoup.
  if (!head && TEXTY.has(ext) && size >= COMPRESS_MIN_BYTES && acceptsGzip(acceptEncoding)) {
    const gz = gzipSync(readFileSync(file));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable, 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': gz.length });
    res.end(gz);
    return true;
  }
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable, 'content-length': size });
  if (head) res.end(); else createReadStream(file).pipe(res);
  return true;
}
