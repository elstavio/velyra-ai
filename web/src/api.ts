declare global { interface Window { __API_BASE__?: string } }
const BASE = (window.__API_BASE__ ?? '').replace(/\/$/, '');

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};
export const tokens = {
  user: () => store.get('vly_token'), setUser: (t: string | null) => store.set('vly_token', t),
  admin: () => store.get('vly_admin_token'), setAdmin: (t: string | null) => store.set('vly_admin_token', t),
};
// Identifiant d'appareil aléatoire (pas d'empreinte numérique) : sert uniquement à reconnaître vos appareils habituels.
function deviceId() {
  let d = store.get('vly_device');
  if (!d) { d = (crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now()); store.set('vly_device', d); }
  return d;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data: any = {}) { super(message); }
}

export async function api<T = any>(path: string, o: { method?: string; body?: unknown; admin?: boolean; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-device-id': deviceId() };
  const t = o.admin ? tokens.admin() : tokens.user();
  if (t) headers.authorization = `Bearer ${t}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try { res = await fetch(BASE + path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }); }
  catch { throw new ApiError(0, 'network', 'Connexion au serveur impossible. Vérifiez votre réseau et réessayez.'); }
  if (o.raw) return res as unknown as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && t) { o.admin ? tokens.setAdmin(null) : tokens.setUser(null); window.dispatchEvent(new Event('vly-auth')); }
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Erreur ${res.status}`, e);
  }
  return data as T;
}

/** Télécharge une réponse authentifiée (export de données, sauvegarde, CSV…). */
export async function download(path: string, filename: string, admin = false) {
  const res = await api<Response>(path, { admin, raw: true });
  if (!res.ok) throw new ApiError(res.status, 'download', 'Téléchargement impossible');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
