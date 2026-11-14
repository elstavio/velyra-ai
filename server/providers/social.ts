import { config } from '../config.js';

/**
 * Connexions aux réseaux sociaux (OAuth 2.0 côté serveur). Chaque plateforme exige que le propriétaire de Velyra AI
 * crée une application développeur et la fasse valider par la plateforme avant que des utilisateurs externes puissent se connecter.
 * Sources : developers.tiktok.com (Login Kit, oauth-user-access-token-management, user info, video list),
 * developers.google.com/youtube (OAuth serveur, channels.list), developers.facebook.com (Facebook Login flux manuel,
 * jetons longue durée, IG User, IG User Media, WhatsApp Cloud API).
 */
export type Platform = 'tiktok' | 'youtube' | 'facebook' | 'instagram' | 'whatsapp';
export const PLATFORMS: Platform[] = ['tiktok', 'youtube', 'facebook', 'instagram', 'whatsapp'];
export const OAUTH_PLATFORMS: Platform[] = ['tiktok', 'youtube', 'facebook', 'instagram'];
export const LABELS: Record<Platform, string> = { tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp Business' };

export type Fetcher = typeof fetch;
export interface Tokens { accessToken: string; refreshToken?: string | null; expiresAt?: string | null; refreshExpiresAt?: string | null; scopes?: string }
export interface Remote { externalId: string; displayName: string; tokens: Tokens; extra?: Record<string, unknown> }
export interface Metrics {
  followers: number | null; posts: number | null; views: number | null; likes: number | null;
  recent: { title: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; at: string | null }[];
}

export const configured = (p: Platform): boolean => {
  const s = config.social;
  switch (p) {
    case 'tiktok': return !!(s.tiktok.clientKey && s.tiktok.clientSecret);
    case 'youtube': return !!(s.youtube.clientId && s.youtube.clientSecret);
    case 'facebook': case 'instagram': return !!(s.meta.appId && s.meta.appSecret);
    case 'whatsapp': return true; // saisie manuelle du jeton : aucune application Velyra requise
  }
};
export const redirectUri = (p: Platform) => `${config.appUrl}/api/social/callback/${p}`;
const iso = (secs: number) => new Date(Date.now() + secs * 1000).toISOString();
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Portées demandées : lecture + publication (la publication n'a lieu qu'après la double validation de l'utilisateur, voir publishing.ts). */
export const SCOPES: Record<Exclude<Platform, 'whatsapp'>, string> = {
  tiktok: 'user.info.basic,user.info.stats,video.list',
  youtube: 'https://www.googleapis.com/auth/youtube.readonly',
  facebook: 'pages_show_list,pages_read_engagement,pages_manage_posts',
  instagram: 'instagram_basic,pages_show_list,pages_read_engagement,instagram_content_publish',
};

export function authUrl(p: Exclude<Platform, 'whatsapp'>, state: string): string {
  const s = config.social;
  if (p === 'tiktok') return `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: s.tiktok.clientKey, scope: SCOPES.tiktok, redirect_uri: redirectUri(p), state, response_type: 'code' })}`;
  if (p === 'youtube') return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: s.youtube.clientId, redirect_uri: redirectUri(p), response_type: 'code', scope: SCOPES.youtube, access_type: 'offline', prompt: 'consent', state })}`;
  return `https://www.facebook.com/${s.meta.version}/dialog/oauth?${new URLSearchParams({ client_id: s.meta.appId, redirect_uri: redirectUri(p), state, scope: SCOPES[p], response_type: 'code' })}`;
}

async function json(res: Response, what: string): Promise<any> {
  const text = await res.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* corps non JSON */ }
  if (!res.ok || j?.error && typeof j.error !== 'object' && j.error !== 'ok' || (j?.error?.code && j.error.code !== 'ok')) {
    const msg = j?.error?.message ?? j?.error_description ?? j?.error ?? text.slice(0, 120);
    throw Object.assign(new Error(`${what} : ${String(msg).slice(0, 160)}`), { status: res.status, code: j?.error?.code });
  }
  return j;
}
const form = (o: Record<string, string>) => new URLSearchParams(o);

/** Échange du code d'autorisation, puis lecture des comptes accessibles. */
export async function exchange(p: Exclude<Platform, 'whatsapp'>, code: string, f: Fetcher = fetch): Promise<Remote[]> {
  const s = config.social;
  if (p === 'tiktok') {
    const t = await json(await f('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_key: s.tiktok.clientKey, client_secret: s.tiktok.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri(p) }) }), 'TikTok (jeton)');
    const tokens: Tokens = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: iso(t.expires_in ?? 86400), refreshExpiresAt: iso(t.refresh_expires_in ?? 365 * 86400), scopes: t.scope };
    const u = await json(await f('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: { authorization: `Bearer ${tokens.accessToken}` } }), 'TikTok (profil)');
    const user = u.data?.user ?? {};
    return [{ externalId: String(t.open_id ?? user.open_id), displayName: String(user.display_name ?? 'Compte TikTok'), tokens }];
  }
  if (p === 'youtube') {
    const t = await json(await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: s.youtube.clientId, client_secret: s.youtube.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri(p) }) }), 'YouTube (jeton)');
    const tokens: Tokens = { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: iso(t.expires_in ?? 3600), scopes: t.scope };
    const c = await json(await f('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${tokens.accessToken}` } }), 'YouTube (chaîne)');
    const ch = c.items?.[0]; if (!ch) throw new Error("Aucune chaîne YouTube n'est associée à ce compte Google.");
    return [{ externalId: String(ch.id), displayName: String(ch.snippet?.title ?? 'Chaîne YouTube'), tokens }];
  }
  // Meta : code → jeton court → jeton long (~60 jours)
  const g = `https://graph.facebook.com/${s.meta.version}`;
  const short = await json(await f(`${g}/oauth/access_token?${new URLSearchParams({ client_id: s.meta.appId, redirect_uri: redirectUri(p), client_secret: s.meta.appSecret, code })}`), 'Meta (jeton)');
  const long = await json(await f(`${g}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: s.meta.appId, client_secret: s.meta.appSecret, fb_exchange_token: short.access_token })}`), 'Meta (jeton longue durée)');
  const userToken: string = long.access_token; const exp = iso(long.expires_in ?? 60 * 86400);
  const pages = await json(await f(`${g}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: userToken })}`), 'Meta (pages)');
  const out: Remote[] = [];
  for (const pg of pages.data ?? []) {
    if (p === 'facebook') out.push({ externalId: String(pg.id), displayName: String(pg.name), tokens: { accessToken: pg.access_token, expiresAt: null, scopes: SCOPES.facebook } }); // jeton de Page : pas d'expiration fixe
    else if (pg.instagram_business_account?.id) out.push({ externalId: String(pg.instagram_business_account.id), displayName: `@${pg.instagram_business_account.username ?? pg.name}`, tokens: { accessToken: userToken, expiresAt: exp, scopes: SCOPES.instagram }, extra: { pageId: pg.id } });
  }
  if (!out.length) throw new Error(p === 'facebook' ? "Aucune Page Facebook administrée n'a été trouvée." : "Aucun compte Instagram professionnel relié à une Page Facebook n'a été trouvé (les comptes personnels ne sont pas pris en charge par l'API).");
  return out;
}

/** Renouvelle le jeton d'accès si la plateforme le permet. Retourne null si une reconnexion est nécessaire. */
export async function refresh(p: Platform, t: Tokens, f: Fetcher = fetch): Promise<Tokens | null> {
  const s = config.social;
  if (p === 'tiktok' && t.refreshToken) {
    const r = await json(await f('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_key: s.tiktok.clientKey, client_secret: s.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: t.refreshToken }) }), 'TikTok (renouvellement)');
    return { accessToken: r.access_token, refreshToken: r.refresh_token ?? t.refreshToken, expiresAt: iso(r.expires_in ?? 86400), refreshExpiresAt: iso(r.refresh_expires_in ?? 365 * 86400), scopes: r.scope ?? t.scopes };
  }
  if (p === 'youtube' && t.refreshToken) {
    const r = await json(await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: s.youtube.clientId, client_secret: s.youtube.clientSecret, grant_type: 'refresh_token', refresh_token: t.refreshToken }) }), 'YouTube (renouvellement)');
    return { ...t, accessToken: r.access_token, expiresAt: iso(r.expires_in ?? 3600) };
  }
  return null;
}

export async function revoke(p: Platform, t: Tokens, f: Fetcher = fetch): Promise<void> {
  const s = config.social;
  try {
    if (p === 'tiktok') await f('https://open.tiktokapis.com/v2/oauth/revoke/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_key: s.tiktok.clientKey, client_secret: s.tiktok.clientSecret, token: t.accessToken }) });
    else if (p === 'youtube') await f('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: t.refreshToken ?? t.accessToken }) });
  } catch { /* la suppression locale prime ; l'utilisateur peut aussi révoquer depuis la plateforme */ }
}

/** Lecture des statistiques publiques/propres au compte (lecture seule). */
export async function fetchMetrics(p: Platform, externalId: string, t: Tokens, f: Fetcher = fetch): Promise<Metrics> {
  const auth = { authorization: `Bearer ${t.accessToken}` };
  const m: Metrics = { followers: null, posts: null, views: null, likes: null, recent: [] };
  if (p === 'tiktok') {
    const u = await json(await f('https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count', { headers: auth }), 'TikTok (statistiques)');
    const user = u.data?.user ?? {}; m.followers = num(user.follower_count); m.likes = num(user.likes_count); m.posts = num(user.video_count);
    const v = await json(await f('https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,view_count,like_count,comment_count,share_count', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ max_count: 20 }) }), 'TikTok (vidéos)');
    m.recent = (v.data?.videos ?? []).map((x: any) => ({ title: String(x.title ?? '').slice(0, 120), views: num(x.view_count), likes: num(x.like_count), comments: num(x.comment_count), shares: num(x.share_count), at: x.create_time ? new Date(Number(x.create_time) * 1000).toISOString() : null }));
  } else if (p === 'youtube') {
    const c = await json(await f('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: auth }), 'YouTube (statistiques)');
    const st = c.items?.[0]?.statistics ?? {}; m.followers = num(st.subscriberCount); m.posts = num(st.videoCount); m.views = num(st.viewCount);
  } else if (p === 'facebook') {
    const r = await json(await f(`https://graph.facebook.com/${config.social.meta.version}/${externalId}?${new URLSearchParams({ fields: 'followers_count,fan_count', access_token: t.accessToken })}`), 'Facebook (page)');
    m.followers = num(r.followers_count ?? r.fan_count);
  } else if (p === 'instagram') {
    const g = `https://graph.facebook.com/${config.social.meta.version}`;
    const r = await json(await f(`${g}/${externalId}?${new URLSearchParams({ fields: 'followers_count,media_count', access_token: t.accessToken })}`), 'Instagram (compte)');
    m.followers = num(r.followers_count); m.posts = num(r.media_count);
    const md = await json(await f(`${g}/${externalId}/media?${new URLSearchParams({ fields: 'caption,like_count,comments_count,timestamp', limit: '20', access_token: t.accessToken })}`), 'Instagram (publications)');
    m.recent = (md.data ?? []).map((x: any) => ({ title: String(x.caption ?? '').slice(0, 120), views: null, likes: num(x.like_count), comments: num(x.comments_count), shares: null, at: x.timestamp ?? null }));
  } else if (p === 'whatsapp') {
    await json(await f(`https://graph.facebook.com/${config.social.meta.version}/${externalId}?fields=display_phone_number,verified_name`, { headers: auth }), 'WhatsApp (numéro)');
  }
  return m;
}

/** WhatsApp : saisie manuelle de l'identifiant du numéro et d'un jeton d'utilisateur système (documentation Meta). Vérifie l'accès. */
export async function verifyWhatsapp(phoneNumberId: string, token: string, f: Fetcher = fetch): Promise<{ displayName: string }> {
  const r = await json(await f(`https://graph.facebook.com/${config.social.meta.version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${token}` } }), 'WhatsApp (vérification)');
  return { displayName: String(r.verified_name ?? r.display_phone_number ?? 'WhatsApp Business') };
}

// ---------------------------------------------------------------- publication (jamais déclenchée par un agent : uniquement par publishing.ts après double validation)
export interface PostPayload { body: string; link?: string | null; imageUrl?: string | null; recipient?: string | null }
export const API_PUBLISH: Platform[] = ['facebook', 'instagram', 'whatsapp'];

/** Facebook : POST /{page-id}/feed (message ou lien, jeton de Page, pages_manage_posts). Instagram : conteneur image_url puis media_publish (JPEG public). WhatsApp : message texte libre vers UN destinataire (fenêtre de 24 h). */
export async function publish(p: Platform, externalId: string, t: Tokens, post: PostPayload, f: Fetcher = fetch): Promise<{ remoteId: string }> {
  const g = `https://graph.facebook.com/${config.social.meta.version}`;
  if (p === 'facebook') {
    const body = new URLSearchParams({ message: post.body, access_token: t.accessToken }); if (post.link) body.set('link', post.link);
    const r = await json(await f(`${g}/${externalId}/feed`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }), 'Facebook (publication)');
    return { remoteId: String(r.id) };
  }
  if (p === 'instagram') {
    if (!post.imageUrl) throw new Error('Instagram exige une image (URL publique, JPEG).');
    const c = await json(await f(`${g}/${externalId}/media`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ image_url: post.imageUrl, caption: post.body, access_token: t.accessToken }) }), 'Instagram (conteneur)');
    const r = await json(await f(`${g}/${externalId}/media_publish`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ creation_id: String(c.id), access_token: t.accessToken }) }), 'Instagram (publication)');
    return { remoteId: String(r.id) };
  }
  if (p === 'whatsapp') {
    const r = await json(await f(`${g}/${externalId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: post.recipient, type: 'text', text: { body: post.body } }) }), 'WhatsApp (envoi)');
    return { remoteId: String(r.messages?.[0]?.id ?? '') };
  }
  throw new Error("Publication par l'API non disponible pour cette plateforme : copiez le contenu et publiez-le vous-même.");
}
