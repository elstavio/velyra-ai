import { useEffect, useState } from 'react';
import { api } from './api';
import { Alert, Err, Field, Loading, Modal, fmtDate, fmtNum, go, useAction, useAsync } from './ui';
import type { Me } from './app1';

const ICON: Record<string, string> = { tiktok: '♪', youtube: '▶', facebook: 'f', instagram: '◎', whatsapp: '✆' };
const KIND_LABEL: Record<string, string> = { plan: 'Plan de contenu sur 7 jours', ideas: '10 idées de contenu', script: 'Script vidéo court', caption: 'Légendes et hashtags', offer: 'Message de vente', analysis: 'Analyse de mes résultats' };
const ERR: Record<string, string> = { etat_invalide: 'La connexion a expiré ou a déjà été utilisée. Recommencez.', refuse: 'Vous avez refusé l\'autorisation : rien n\'a été connecté.', offre: 'Votre offre Social n\'est plus active.', compte: 'Compte indisponible.', plateforme: 'Plateforme inconnue.', echec: 'La plateforme a refusé la connexion.' };

function Hint() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (q.get('connected')) return <Alert kind="ok">Connexion réussie ({q.get('n')} compte(s)). Cliquez sur « Actualiser les chiffres » pour voir vos statistiques.</Alert>;
  if (q.get('error')) return <Alert kind="err">{ERR[q.get('error')!] ?? 'Erreur de connexion.'}{q.get('detail') ? ` (${q.get('detail')})` : ''}</Alert>;
  return null;
}

export function Social({ me, reload }: { me: Me; reload: () => void }) {
  const pl = useAsync(() => api('/api/social/platforms')); const ac = useAsync(() => api('/api/social/accounts'));
  const a = useAction(); const [wa, setWa] = useState({ phoneNumberId: '', token: '' }); const [showWa, setShowWa] = useState(false);
  const entitled = !!(pl.data as any)?.entitled; const accounts = ((ac.data as any)?.accounts ?? []) as any[];
  const connect = (p: string) => a.run(async () => { const r = await api(`/api/social/${p}/connect`, { body: {} }); location.href = r.url; });
  useEffect(() => { void me; }, [me]);
  if (pl.loading) return <Loading />;
  return (
    <div className="stack fadein">
      <h1 className="h1-page">Réseaux sociaux</h1>
      <Hint />
      {!entitled && <div className="card"><h3>Offre « Velyra Social »</h3>
        <p>Connectez vos comptes pour que l'agent Créateur de contenu travaille avec <b>vos vrais chiffres</b> (abonnés, vues, publications qui marchent) au lieu de conseils génériques. Incluse : tout Velyra Pro.</p>
        <p className="tiny">Aucun résultat ni revenu n'est garanti : l'agent vous aide à mieux décider, il ne remplace ni votre travail ni les règles des plateformes.</p>
        <a className="btn primary" href="#/offres">Voir l'offre Social</a></div>}
      <div className="grid">{((pl.data as any)?.platforms ?? []).map((p: any) => {
        const mine = accounts.filter((x) => x.platform === p.platform);
        return (<div className="card" key={p.platform}>
          <h3><span aria-hidden="true" style={{ marginRight: 8 }}>{ICON[p.platform]}</span>{p.label}</h3>
          {mine.length > 0 && <p className="tiny">{mine.length} compte(s) connecté(s)</p>}
          {p.manual ? (<>
            <p className="muted tiny">Se connecte avec l'identifiant du numéro et un jeton d'utilisateur système créés dans Meta Business (documentation WhatsApp Cloud API).</p>
            <button className="btn" disabled={!entitled} onClick={() => setShowWa(!showWa)}>{showWa ? 'Fermer' : 'Connecter'}</button>
          </>) : (<>
            {!p.available && <p className="muted tiny">Pas encore activé par l'administrateur du service.</p>}
            <button className="btn primary" disabled={!entitled || !p.available || a.busy} onClick={() => connect(p.platform)}>Connecter</button>
          </>)}
        </div>);
      })}</div>
      {showWa && entitled && <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/social/whatsapp/connect', { body: wa }); setShowWa(false); setWa({ phoneNumberId: '', token: '' }); ac.reload(); }); }}>
        <h3>Connecter WhatsApp Business</h3>
        <Field label="Identifiant du numéro (Phone number ID)"><input inputMode="numeric" required value={wa.phoneNumberId} onChange={(e) => setWa({ ...wa, phoneNumberId: e.target.value })} /></Field>
        <Field label="Jeton d'accès (utilisateur système)" hint="Chiffré sur nos serveurs, jamais affiché."><input type="password" autoComplete="off" required value={wa.token} onChange={(e) => setWa({ ...wa, token: e.target.value })} /></Field>
        <button className="btn primary" disabled={a.busy}>Vérifier et connecter</button></form>}
      <Err error={a.error} />
      <h2 style={{ fontSize: '1.15rem' }}>Mes comptes connectés</h2>
      {ac.loading ? <Loading /> : accounts.length === 0 ? <p className="muted">Aucun compte connecté pour le moment.</p> : accounts.map((x) => (
        <div className="card" key={x.id}>
          <div className="row between"><div><b>{x.label}</b> · {x.displayName}</div>
            <div className="row">
              {x.status === 'reconnect' && <span className="chip bad">reconnexion nécessaire</span>}{x.status === 'error' && <span className="chip warn">erreur temporaire</span>}{x.locked && <span className="chip warn">offre expirée</span>}
              {x.platform !== 'whatsapp' && <button className="btn sm" disabled={a.busy || x.locked} onClick={() => a.run(async () => { await api(`/api/social/accounts/${x.id}/sync`, { body: {} }); ac.reload(); })}>Actualiser les chiffres</button>}
              <button className="btn sm danger" onClick={() => { if (confirm('Déconnecter ce compte ? Les jetons seront supprimés et l\'accès révoqué chez la plateforme quand elle le permet.')) a.run(async () => { await api(`/api/social/accounts/${x.id}`, { method: 'DELETE' }); ac.reload(); }); }}>Déconnecter</button></div></div>
          {x.lastError && <p className="tiny">{x.lastError}</p>}
          {x.metrics ? <p className="tiny" style={{ marginBottom: 0 }}>Abonnés : <b>{x.metrics.followers != null ? fmtNum(x.metrics.followers) : '—'}</b> · Publications : <b>{x.metrics.posts != null ? fmtNum(x.metrics.posts) : '—'}</b>{x.metrics.views != null && <> · Vues : <b>{fmtNum(x.metrics.views)}</b></>} · Mis à jour {fmtDate(x.syncedAt)}</p> : x.platform !== 'whatsapp' && <p className="tiny" style={{ marginBottom: 0 }}>Pas encore de chiffres : cliquez sur « Actualiser les chiffres ».</p>}
        </div>))}
      <Studio entitled={entitled} hasAccounts={accounts.length > 0} reload={reload} kinds={(pl.data as any)?.kinds ?? Object.keys(KIND_LABEL)} />
      <Drafts entitled={entitled} accounts={accounts} reload={reload} />
      <p className="tiny">Rien n'est jamais publié sans votre double validation, pour chaque contenu. Les plateformes imposent à l'éditeur de Velyra AI une validation d'application ; tant qu'elle n'est pas obtenue, la connexion peut être limitée aux comptes testeurs.</p>
    </div>
  );
}

function Studio({ entitled, hasAccounts, reload, kinds }: { entitled: boolean; hasAccounts: boolean; reload: () => void; kinds: string[] }) {
  const [f, setF] = useState({ profile: 'creator', platform: 'tiktok', kind: 'plan', topic: '', audience: '', goal: '' }); const a = useAction(); const [out, setOut] = useState<any>(null);
  const hist = useAsync(() => api('/api/social/content')); const items = ((hist.data as any)?.items ?? []) as any[];
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <div className="stack">
      <h2 style={{ fontSize: '1.15rem' }}>Studio contenu : agent « Créateur de contenu »</h2>
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api('/api/social/content', { body: f }); setOut(r); hist.reload(); reload(); }); }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <Field label="Je suis"><select value={f.profile} onChange={(e) => set('profile', e.target.value)}><option value="creator">Créateur de contenu</option><option value="merchant">Commerçant</option></select></Field>
          <Field label="Plateforme"><select value={f.platform} onChange={(e) => set('platform', e.target.value)}><option value="general">Toutes</option><option value="tiktok">TikTok</option><option value="youtube">YouTube</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="whatsapp">WhatsApp</option></select></Field>
          <Field label="Je veux"><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}</select></Field>
        </div>
        <Field label={f.profile === 'merchant' ? 'Mon produit ou service' : 'Mon thème ou ma chaîne'}><textarea required minLength={3} maxLength={1200} rows={3} value={f.topic} onChange={(e) => set('topic', e.target.value)} placeholder={f.profile === 'merchant' ? 'Ex. : pagnes wax et tenues sur mesure, livraison à Abidjan, paiement Wave' : 'Ex. : recettes ivoiriennes rapides pour étudiants'} /></Field>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <Field label="Public visé (facultatif)"><input maxLength={300} value={f.audience} onChange={(e) => set('audience', e.target.value)} /></Field>
          <Field label="Objectif (facultatif)"><input maxLength={300} value={f.goal} onChange={(e) => set('goal', e.target.value)} placeholder="Ex. : 20 commandes WhatsApp par semaine" /></Field>
        </div>
        <p className="tiny">{entitled ? (hasAccounts ? 'L\'agent utilisera les chiffres de vos comptes connectés.' : 'Connectez un compte pour que l\'agent utilise vos vrais chiffres.') : 'Sans l\'offre Social, l\'agent ne voit pas vos chiffres (chaque demande utilise un essai gratuit ou votre abonnement).'}</p>
        <Err error={a.error} /><button className="btn primary" disabled={a.busy}>{a.busy ? 'Rédaction…' : 'Générer'}</button>
      </form>
      {out && <div className="card"><div className="row between"><h3 style={{ margin: 0 }}>Résultat</h3><button className="btn sm" onClick={() => navigator.clipboard?.writeText(out.output).catch(() => undefined)}>Copier</button></div>
        <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', margin: '8px 0' }}>{out.output}</pre><p className="tiny" style={{ margin: 0 }}>{out.notice}{out.provider === 'local' ? ' (Mode démonstration : aucun modèle d\'IA connecté.)' : ''}</p></div>}
      {items.length > 0 && <div className="card"><h3>Mes contenus enregistrés</h3>{items.map((i) => (
        <details key={i.id} style={{ marginBottom: 8 }}><summary>{KIND_LABEL[i.kind] ?? i.kind} · {i.title} <span className="tiny">({fmtDate(i.created_at)})</span></summary>
          <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit' }}>{i.output}</pre>
          <button className="btn sm danger" onClick={() => a.run(async () => { await api(`/api/social/content/${i.id}`, { method: 'DELETE' }); hist.reload(); })}>Supprimer</button></details>))}</div>}
    </div>
  );
}
void go;

const PLAT = ['facebook', 'instagram', 'whatsapp', 'tiktok', 'youtube'];
const ST: Record<string, [string, string]> = { draft: ['brouillon', 'warn'], publishing: ['en cours', 'warn'], published: ['publié', 'good'], failed: ['échec', 'bad'], manual_done: ['validé (publication manuelle)', 'good'] };

function Drafts({ entitled, accounts, reload }: { entitled: boolean; accounts: any[]; reload: () => void }) {
  const d = useAsync(() => api('/api/social/drafts')); const a = useAction(); const items = ((d.data as any)?.drafts ?? []) as any[]; const killed = !!(d.data as any)?.killed;
  const [g, setG] = useState({ platform: 'facebook', topic: '', count: 3, profile: 'merchant', accountId: '', recipient: '' }); const [review, setReview] = useState<any>(null);
  if (!entitled) return null;
  return (
    <div className="stack">
      <h2 style={{ fontSize: '1.15rem' }}>Publications : agent « Rédacteur »</h2>
      <p className="tiny" style={{ margin: 0 }}>L'agent rédige des <b>brouillons</b>. Il ne publie jamais. Pour chaque publication vous devez : (1) relire le contenu exact, (2) autoriser, (3) confirmer l'avoir vérifié.</p>
      {killed && <Alert kind="warn">La publication est temporairement suspendue par l'administrateur.</Alert>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/social/drafts/generate', { body: { ...g, accountId: g.accountId || undefined, recipient: g.platform === 'whatsapp' ? g.recipient : undefined } }); d.reload(); reload(); }); }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <Field label="Plateforme"><select value={g.platform} onChange={(e) => setG({ ...g, platform: e.target.value, accountId: '' })}>{PLAT.map((p) => <option key={p} value={p}>{p === 'whatsapp' ? 'WhatsApp' : p[0].toUpperCase() + p.slice(1)}</option>)}</select></Field>
          <Field label="Compte"><select value={g.accountId} onChange={(e) => setG({ ...g, accountId: e.target.value })}><option value="">— aucun —</option>{accounts.filter((x) => x.platform === g.platform).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</select></Field>
          <Field label="Variantes"><select value={g.count} onChange={(e) => setG({ ...g, count: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select></Field>
        </div>
        {g.platform === 'whatsapp' && <Field label="Numéro du destinataire (format international)" hint="Une seule personne, qui a accepté d'être contactée."><input inputMode="tel" required value={g.recipient} onChange={(e) => setG({ ...g, recipient: e.target.value })} /></Field>}
        <Field label="Sujet, produit ou message à faire rédiger"><textarea required minLength={3} maxLength={1200} rows={3} value={g.topic} onChange={(e) => setG({ ...g, topic: e.target.value })} /></Field>
        <Err error={a.error} /><button className="btn primary" disabled={a.busy}>{a.busy ? 'Rédaction…' : 'Faire rédiger des brouillons'}</button>
      </form>
      {d.loading ? <Loading /> : items.map((x) => <DraftCard key={x.id} x={x} accounts={accounts} onChange={() => d.reload()} onReview={() => a.run(async () => setReview(await api(`/api/social/drafts/${x.id}`)))} />)}
      {review && <ReviewModal post={review} statement={(d.data as any)?.statement} onClose={() => setReview(null)} onDone={() => { setReview(null); d.reload(); }} />}
    </div>
  );
}

function DraftCard({ x, accounts, onChange, onReview }: { x: any; accounts: any[]; onChange: () => void; onReview: () => void }) {
  const [f, setF] = useState({ body: x.body, link: x.link ?? '', imageUrl: x.imageUrl ?? '', recipient: x.recipient ?? '', accountId: x.accountId ?? '' }); const a = useAction();
  const editable = x.status === 'draft' || x.status === 'failed'; const [lbl, cls] = ST[x.status] ?? [x.status, 'warn']; const dirty = f.body !== x.body || f.link !== (x.link ?? '') || f.imageUrl !== (x.imageUrl ?? '') || f.recipient !== (x.recipient ?? '') || f.accountId !== (x.accountId ?? '');
  return (
    <div className="card">
      <div className="row between"><b>{x.label}{x.title ? ` · ${x.title}` : ''}</b><div className="row"><span className="chip">{x.createdBy === 'agent' ? 'rédigé par l\'agent' : 'écrit par vous'}</span><span className={`chip ${cls}`}>{lbl}</span></div></div>
      <Field label="Texte"><textarea rows={5} disabled={!editable} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      {editable && <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        {x.platform === 'facebook' && <Field label="Lien (facultatif, https)"><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} /></Field>}
        {x.platform === 'instagram' && <Field label="Image (URL https publique, JPEG)"><input value={f.imageUrl} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} /></Field>}
        {x.platform === 'whatsapp' && <Field label="Destinataire"><input value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value })} /></Field>}
        {!x.manualOnly && <Field label="Compte"><select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}><option value="">— choisir —</option>{accounts.filter((c) => c.platform === x.platform).map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select></Field>}
      </div>}
      {x.manualOnly && editable && <p className="tiny">TikTok et YouTube : la publication automatique n'est pas disponible dans cette version. Validez le contenu, copiez-le, puis publiez-le vous-même.</p>}
      {x.error && <Alert kind="err">{x.error}</Alert>}{x.remoteId && <p className="tiny">Identifiant chez la plateforme : {x.remoteId}</p>}
      <Err error={a.error} />
      {editable ? <div className="row">
        <button className="btn sm" disabled={!dirty || a.busy} onClick={() => a.run(async () => { await api(`/api/social/drafts/${x.id}`, { method: 'PUT', body: { body: f.body, link: f.link || null, imageUrl: f.imageUrl || null, recipient: f.recipient || undefined, accountId: f.accountId || null } }); onChange(); })}>Enregistrer les modifications</button>
        <button className="btn primary sm" disabled={dirty || a.busy || (!x.manualOnly && !x.accountId)} onClick={onReview} title={dirty ? 'Enregistrez d\'abord vos modifications' : undefined}>Relire et publier…</button>
        <button className="btn sm danger" onClick={() => a.run(async () => { await api(`/api/social/drafts/${x.id}`, { method: 'DELETE' }); onChange(); })}>Supprimer</button>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(x.body).catch(() => undefined)}>Copier</button></div>
        : <p className="tiny" style={{ margin: 0 }}>{x.publishedAt ? `Le ${fmtDate(x.publishedAt)} · ` : ''}{x.approvals?.length ?? 0} validation(s) enregistrée(s).</p>}
    </div>
  );
}

/**
 * Double validation : le contenu exact est affiché ; les deux cases sont obligatoires ; l'empreinte du
 * contenu affiché est envoyée au serveur.
 *
 * M1 (Phase 4) : la coquille (trame de fond, carte, piège de focus, restitution du focus, fermeture au
 * clavier) vient désormais du composant partagé Modal (web/src/ui.tsx) — toute la logique métier ci-dessous
 * est inchangée à l'identique : mêmes trois cases à cocher, même condition "ready", et surtout même
 * empreinte contentHash, générée exactement comme avant (post.contentHash, fournie par le serveur avec le
 * brouillon) et envoyée telle quelle dans la charge utile de /api/social/drafts/:id/publish — ni sa
 * génération, ni sa valeur, ni sa présence dans la requête n'ont été modifiées par cette extraction.
 */
function ReviewModal({ post, statement, onClose, onDone }: { post: any; statement: string; onClose: () => void; onDone: () => void }) {
  const [c1, setC1] = useState(false); const [c2, setC2] = useState(false); const [c3, setC3] = useState(false); const a = useAction(); const [res, setRes] = useState<any>(null);
  const ready = c1 && c2 && (!post.needsRecipientConsent || c3);
  return (
    <Modal ariaLabel="Relire avant de publier" onClose={a.busy ? undefined : (res ? onDone : onClose)}>
        <h3 style={{ marginTop: 0 }}>Relire avant de publier</h3>
        <p className="tiny">Vers : <b>{post.label}</b>{post.accountName ? ` · ${post.accountName}` : ''}{post.recipient ? ` · destinataire ${post.recipient}` : ''}</p>
        <p style={{ margin: '4px 0' }}><b>Voici exactement ce qui sera publié :</b></p>
        <pre data-testid="exact-content" style={{ whiteSpace: 'pre-wrap', font: 'inherit', background: 'var(--surface-2)', padding: 12, borderRadius: 8, margin: 0 }}>{post.body}</pre>
        {post.link && <p className="tiny">Lien : {post.link}</p>}{post.imageUrl && <p className="tiny">Image : {post.imageUrl}</p>}
        {res ? (<><Alert kind="ok">{res.message ?? 'Publié.'}</Alert><button className="btn primary" onClick={onDone}>Fermer</button></>) : (<>
          <label className="row" style={{ alignItems: 'flex-start', gap: 8, marginTop: 12 }}><input type="checkbox" checked={c1} onChange={(e) => setC1(e.target.checked)} /><span>1. J'autorise la publication de ce contenu.</span></label>
          <label className="row" style={{ alignItems: 'flex-start', gap: 8, marginTop: 8 }}><input type="checkbox" checked={c2} onChange={(e) => setC2(e.target.checked)} /><span>2. J'ai vérifié que ce contenu est exactement celui que je souhaite publier.</span></label>
          {post.needsRecipientConsent && <label className="row" style={{ alignItems: 'flex-start', gap: 8, marginTop: 8 }}><input type="checkbox" checked={c3} onChange={(e) => setC3(e.target.checked)} /><span>3. Le destinataire a accepté d'être contacté sur WhatsApp.</span></label>}
          <Err error={a.error} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!ready || a.busy} onClick={() => a.run(async () => setRes(await api(`/api/social/drafts/${post.id}/publish`, { body: { authorize: c1, verified: c2, recipientConsent: post.needsRecipientConsent ? c3 : undefined, contentHash: post.contentHash } })))}>{a.busy ? 'Publication…' : post.manualOnly ? 'Valider ce contenu' : 'Publier maintenant'}</button>
            <button className="btn" disabled={a.busy} onClick={onClose}>Annuler</button></div>
          <p className="tiny">Votre double validation est enregistrée avec la date, votre adresse IP et l'empreinte du contenu. {statement ? '' : ''}</p></>)}
    </Modal>
  );
}

