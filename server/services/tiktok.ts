import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { COUNTRIES } from '../data/regions.js';
import { HttpError, bad, forbidden, int, nowIso, str, uid } from '../lib/util.js';
import type { UserRow } from './auth.js';
import { getEntitlements, withTask } from './entitlements.js';
import * as socialSvc from './social.js';
import * as socialP from '../providers/social.js';

/**
 * Module d'analyse TikTok (§14). Par défaut, il n'accède à AUCUN compte TikTok : il analyse les données que
 * l'utilisateur saisit ou importe lui-même (statistiques de son propre compte, issues de TikTok Studio/Analytics).
 * Aucune méthode d'amplification artificielle n'est proposée et aucun résultat de monétisation n'est promis.
 * Un import optionnel (importFromConnected, plus bas) peut aller chercher ces mêmes chiffres automatiquement,
 * mais uniquement si l'utilisateur a connecté son compte via l'OAuth officiel TikTok (page « Réseaux sociaux »,
 * offre Social) — jamais sans action explicite de sa part.
 */
const need = () => { if (!config.flags.tiktok) throw forbidden('Module TikTok désactivé', 'feature_disabled'); };

export async function listAccounts(db: Db, userId: string) {
  need();
  return db.query<any>(`SELECT a.id,a.handle,a.country,a.category,a.created_at,
    (SELECT COUNT(*) FROM tiktok_posts p WHERE p.account_id=a.id) AS posts,
    (SELECT followers FROM tiktok_snapshots s WHERE s.account_id=a.id ORDER BY taken_on DESC LIMIT 1) AS followers
    FROM tiktok_accounts a WHERE a.user_id=$1 ORDER BY a.created_at DESC`, [userId]);
}
export async function createAccount(db: Db, userId: string, b: { handle: unknown; country?: unknown; category?: unknown }) {
  need();
  const handle = str(b.handle, 'identifiant', { min: 2, max: 40 }).replace(/^@/, '');
  if (!/^[A-Za-z0-9._]+$/.test(handle)) throw bad('invalid_handle', 'Identifiant TikTok invalide');
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tiktok_accounts WHERE user_id=$1`, [userId]))?.n ?? 0;
  if (n >= 5) throw bad('accounts_full', 'Maximum 5 comptes suivis');
  const country = b.country ? String(b.country).toUpperCase() : null;
  if (country && !COUNTRIES[country]) throw bad('invalid_country', 'Pays inconnu');
  const id = uid();
  await db.run(`INSERT INTO tiktok_accounts (id,user_id,handle,country,category,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, userId, handle, country, b.category ? str(b.category, 'catégorie', { max: 40 }) : null, nowIso()]);
  return id;
}
async function own(db: Db, userId: string, accountId: string) {
  const a = await db.get<any>(`SELECT * FROM tiktok_accounts WHERE id=$1 AND user_id=$2`, [accountId, userId]);
  if (!a) throw new HttpError(404, 'not_found', 'Compte introuvable');
  return a;
}
export async function deleteAccount(db: Db, userId: string, id: string) {
  await own(db, userId, id);
  await db.tx(async (t) => {
    await t.run(`DELETE FROM tiktok_posts WHERE account_id=$1`, [id]);
    await t.run(`DELETE FROM tiktok_snapshots WHERE account_id=$1`, [id]);
    await t.run(`DELETE FROM tiktok_accounts WHERE id=$1`, [id]);
  });
}

export async function addSnapshot(db: Db, userId: string, accountId: string, b: { followers: unknown; date?: unknown }) {
  await own(db, userId, accountId);
  const day = b.date ? String(b.date).slice(0, 10) : nowIso().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('invalid_date', 'Date invalide (AAAA-MM-JJ)');
  await db.run(`INSERT INTO tiktok_snapshots (id,account_id,taken_on,followers,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,taken_on) DO UPDATE SET followers=excluded.followers`, [uid(), accountId, day, int(b.followers, 'abonnés', { max: 2_000_000_000 }), nowIso()]);
}

export interface PostIn { postedAt: string; caption?: string; views: number; likes: number; comments: number; shares: number; format?: string; durationS?: number }
export const extractHashtags = (caption: string) => [...new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.toLowerCase()))];

export async function addPosts(db: Db, userId: string, accountId: string, posts: PostIn[]) {
  await own(db, userId, accountId);
  if (!Array.isArray(posts) || !posts.length || posts.length > 500) throw bad('invalid_posts', 'Fournissez entre 1 et 500 vidéos');
  const total = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tiktok_posts WHERE account_id=$1`, [accountId]))?.n ?? 0;
  if (total + posts.length > 2000) throw bad('posts_full', 'Limite de 2000 vidéos par compte');
  await db.tx(async (t) => {
    for (const p of posts) {
      const at = new Date(p.postedAt);
      if (isNaN(+at)) throw bad('invalid_date', `Date invalide : ${String(p.postedAt).slice(0, 30)}`);
      const nn = (v: unknown, name: string) => int(v, name, { max: 2_000_000_000 });
      const cap = String(p.caption ?? '').slice(0, 500);
      await t.run(`INSERT INTO tiktok_posts (id,account_id,posted_at,caption,hashtags,views,likes,comments,shares,format,duration_s,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uid(), accountId, at.toISOString(), cap, extractHashtags(cap).join(' '), nn(p.views, 'vues'), nn(p.likes, 'j\'aime'), nn(p.comments, 'commentaires'), nn(p.shares, 'partages'), p.format ? String(p.format).slice(0, 30) : null, p.durationS ? nn(p.durationS, 'durée') : null, nowIso()]);
    }
  });
  return posts.length;
}

/**
 * Importe les vraies statistiques depuis le compte TikTok connecté par l'utilisateur (OAuth officiel,
 * page « Réseaux sociaux », offre Social) au lieu d'un collage CSV manuel. Échoue honnêtement si aucun
 * compte n'est connecté ou si l'offre Social n'est pas active — jamais de données inventées.
 */
export async function importFromConnected(db: Db, user: UserRow, accountId: string) {
  need();
  await own(db, user.id, accountId);
  await socialSvc.requireSocial(db, user);
  const social = await db.get<any>(`SELECT * FROM social_accounts WHERE user_id=$1 AND platform='tiktok' ORDER BY created_at DESC LIMIT 1`, [user.id]);
  if (!social) throw bad('tiktok_not_connected', 'Aucun compte TikTok connecté. Connectez-le depuis « Réseaux sociaux » avant d\'importer vos vraies statistiques.');
  const t = await socialSvc.freshTokens(db, social);
  if (!t) throw bad('tiktok_reconnect', 'La connexion TikTok a expiré : reconnectez-la depuis « Réseaux sociaux ».');
  const m = await socialP.fetchMetrics('tiktok', social.external_id, t);
  if (m.followers != null) await addSnapshot(db, user.id, accountId, { followers: m.followers });
  const posts: PostIn[] = m.recent.filter((r) => r.at).map((r) => ({ postedAt: r.at as string, caption: r.title, views: r.views ?? 0, likes: r.likes ?? 0, comments: r.comments ?? 0, shares: r.shares ?? 0 }));
  const added = posts.length ? await addPosts(db, user.id, accountId, posts) : 0;
  return { added, followers: m.followers };
}

/** Import CSV (copié depuis TikTok Studio ou un tableur) : date,legende,vues,likes,commentaires,partages[,format,duree_s] */
export function parseCsv(text: string): PostIn[] {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw bad('invalid_csv', 'CSV vide : une ligne d\'en-tête puis une ligne par vidéo');
  const sep = lines[0].includes(';') ? ';' : ',';
  const split = (l: string) => { const out: string[] = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
  const head = split(lines[0]).map((h) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const idx = { date: col('date', 'posted_at'), cap: col('legende', 'caption', 'description'), v: col('vues', 'views'), l: col('likes', 'jaime', "j'aime"), c: col('commentaires', 'comments'), s: col('partages', 'shares'), f: col('format'), d: col('duree_s', 'duree', 'duration_s') };
  if (idx.date < 0 || idx.v < 0) throw bad('invalid_csv', 'Colonnes requises : date et vues (puis likes, commentaires, partages)');
  return lines.slice(1).map((l, i) => {
    const c = split(l); const n = (k: number) => (k >= 0 ? Number(String(c[k] ?? '0').replace(/[\s,]/g, '')) || 0 : 0);
    if (!c[idx.date]) throw bad('invalid_csv', `Ligne ${i + 2} : date manquante`);
    return { postedAt: c[idx.date], caption: idx.cap >= 0 ? c[idx.cap] : '', views: n(idx.v), likes: n(idx.l), comments: n(idx.c), shares: n(idx.s), format: idx.f >= 0 ? c[idx.f] : undefined, durationS: idx.d >= 0 ? n(idx.d) : undefined };
  });
}

// ----------------------------------------------------------------------------- analyse
interface P { posted_at: string; caption: string; hashtags: string; views: number; likes: number; comments: number; shares: number; format: string | null; duration_s: number | null }
const eng = (p: P) => (p.views > 0 ? (p.likes + p.comments + p.shares) / p.views : 0);
const pct = (x: number) => Math.round(x * 1000) / 10;
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export function analyzePosts(posts: P[], { tzOffsetMinutes = 0, advanced = false, country = null as string | null, category = null as string | null } = {}) {
  const n = posts.length;
  const totalViews = posts.reduce((a, p) => a + p.views, 0);
  const withViews = posts.filter((p) => p.views > 0);
  const overall = withViews.length ? avg(withViews.map(eng)) : 0;
  const sorted = [...posts].sort((a, b) => b.views - a.views);
  const dates = posts.map((p) => +new Date(p.posted_at)).sort((a, b) => a - b);
  const spanWeeks = n > 1 ? Math.max(1, (dates[n - 1] - dates[0]) / (7 * 86_400_000)) : 1;
  const basic = {
    posts: n, totalViews, avgViews: Math.round(totalViews / Math.max(1, n)), engagementRatePct: pct(overall),
    postsPerWeek: Math.round((n / spanWeeks) * 10) / 10,
    topPosts: sorted.slice(0, 5).map((p) => ({ postedAt: p.posted_at, caption: p.caption.slice(0, 80), views: p.views, engagementPct: pct(eng(p)) })),
  };
  if (!advanced) return { basic, advanced: null as null | Record<string, unknown> };

  const local = (iso: string) => new Date(+new Date(iso) + tzOffsetMinutes * 60_000);
  const bucket = <K>(key: (p: P) => K, minN: number) => {
    const m = new Map<K, P[]>();
    for (const p of posts) { const k = key(p); m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()].filter(([, v]) => v.length >= minN).map(([k, v]) => ({ key: k, n: v.length, avgViews: Math.round(avg(v.map((p) => p.views))), engagementPct: pct(avg(v.filter((p) => p.views > 0).map(eng))) })).sort((a, b) => b.avgViews - a.avgViews);
  };
  const byWeekday = bucket((p) => local(p.posted_at).getUTCDay(), 2).map((b) => ({ ...b, key: WEEKDAYS[b.key as number] }));
  const byHour = bucket((p) => local(p.posted_at).getUTCHours(), 2).map((b) => ({ ...b, key: `${String(b.key).padStart(2, '0')}h` }));
  const byFormat = bucket((p) => p.format || 'non précisé', 2);
  const tagMap = new Map<string, P[]>();
  for (const p of posts) for (const h of p.hashtags.split(' ').filter(Boolean)) tagMap.set(h, [...(tagMap.get(h) ?? []), p]);
  const tags = [...tagMap.entries()].filter(([, v]) => v.length >= 2).map(([h, v]) => ({ hashtag: h, n: v.length, avgViews: Math.round(avg(v.map((p) => p.views))) })).sort((a, b) => b.avgViews - a.avgViews);
  const durations = posts.filter((p) => p.duration_s);
  const short = durations.filter((p) => (p.duration_s ?? 0) <= 30), long = durations.filter((p) => (p.duration_s ?? 0) > 30);

  const recs: string[] = [];
  if (n < 10) recs.push(`Seulement ${n} vidéos analysées : les tendances ci-dessous sont peu fiables. Ajoutez plus de vidéos pour des recommandations solides.`);
  if (basic.postsPerWeek < 3 && n >= 4) recs.push(`Vous publiez environ ${basic.postsPerWeek} vidéo(s) par semaine. Tester un rythme plus régulier permet de mesurer si la fréquence influence vos vues.`);
  if (byWeekday[0] && byWeekday.length >= 2) recs.push(`Vos vidéos publiées le ${byWeekday[0].key} ont en moyenne le plus de vues (${byWeekday[0].avgViews}), sur ${byWeekday[0].n} vidéos. Corrélation observée, pas garantie de causalité.`);
  if (byHour[0] && byHour.length >= 2) recs.push(`Créneau le plus performant dans vos données : ${byHour[0].key} (décalage horaire appliqué : UTC${tzOffsetMinutes >= 0 ? '+' : ''}${tzOffsetMinutes / 60}).`);
  if (byFormat.length >= 2) recs.push(`Format le plus performant : « ${byFormat[0].key} » (${byFormat[0].avgViews} vues en moyenne) contre « ${byFormat[byFormat.length - 1].key} » (${byFormat[byFormat.length - 1].avgViews}).`);
  if (short.length >= 3 && long.length >= 3) recs.push(`Vidéos ≤ 30 s : ${Math.round(avg(short.map((p) => p.views)))} vues en moyenne ; > 30 s : ${Math.round(avg(long.map((p) => p.views)))}.`);
  if (tags[0]) recs.push(`Votre hashtag le plus efficace : ${tags[0].hashtag} (${tags[0].avgViews} vues en moyenne sur ${tags[0].n} vidéos).`);

  // Suggestions de départ : construites à partir du pays et de la catégorie déclarés, SANS données de tendance.
  const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const seeds = new Set<string>();
  if (country && COUNTRIES[country]) seeds.add('#' + slug(COUNTRIES[country].name));
  if (category) seeds.add('#' + slug(category));
  seeds.add('#afrique');
  return {
    basic,
    advanced: {
      byWeekday, byHour, byFormat, topHashtags: tags.slice(0, 8), recommendations: recs, tzOffsetMinutes,
      suggestedHashtags: { items: [...seeds], note: 'Suggestions de départ à tester, construites à partir de votre pays et de votre catégorie. Elles ne proviennent pas de données de tendances TikTok.' },
      marketTrends: null, marketTrendsNote: 'Les tendances de marché ne sont pas disponibles : elles exigent un accès aux outils officiels de TikTok, non connecté dans cette version.',
    },
  };
}

export async function analyze(db: Db, user: UserRow, accountId: string, o: { advanced?: boolean; tzOffsetMinutes?: number }) {
  need();
  const acc = await own(db, user.id, accountId);
  const posts = await db.query<P>(`SELECT posted_at,caption,hashtags,views,likes,comments,shares,format,duration_s FROM tiktok_posts WHERE account_id=$1 ORDER BY posted_at`, [accountId]);
  if (!posts.length) throw bad('no_data', 'Ajoutez d\'abord les statistiques de vos vidéos (saisie ou import CSV)');
  const ent = await getEntitlements(db, user);
  const wantAdvanced = o.advanced !== false;
  const advanced = wantAdvanced && ent.tiktokAdvanced;
  const { result } = await withTask(db, user, 'tiktok_analysis', { accountId, advanced }, async () => analyzePosts(posts, { tzOffsetMinutes: o.tzOffsetMinutes ?? 0, advanced, country: acc.country, category: acc.category }));
  const snaps = await db.query<{ taken_on: string; followers: number }>(`SELECT taken_on,followers FROM tiktok_snapshots WHERE account_id=$1 ORDER BY taken_on`, [accountId]);
  const growth = snaps.length >= 2 ? { from: snaps[0], to: snaps[snaps.length - 1], delta: snaps[snaps.length - 1].followers - snaps[0].followers } : null;
  return {
    account: { id: acc.id, handle: acc.handle }, ...result, growth, snapshots: snaps,
    advancedLocked: wantAdvanced && !ent.tiktokAdvanced,
    limits: 'Aucune garantie de monétisation ni de viralité : ces recommandations reposent sur vos données passées.',
  };
}
export { forbidden };
