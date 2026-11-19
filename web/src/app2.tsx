import { useEffect, useState } from 'react';
import { api, download, tokens } from './api';
import { Alert, Bars, Err, Field, Loading, StatusChip, Table, fmtDate, fmtMoney, fmtNum, go, useAction, useAsync } from './ui';
import type { Me } from './app1';

/* ------------------------------------------------------------------ Workflows */
export function Workflows() {
  const w = useAsync(() => api('/api/workflows')); const ag = useAsync(() => api('/api/agents').catch(() => ({ agents: [] })));
  const [name, setName] = useState(''); const [steps, setSteps] = useState<any[]>([{ type: 'prompt', prompt: '' }]); const a = useAction();
  const [run, setRun] = useState<{ id: string; input: string } | null>(null); const [result, setResult] = useState<any>(null); const r = useAction();
  const agents = (ag.data as any)?.agents ?? []; const list = (w.data as any)?.workflows ?? [];
  const upd = (i: number, p: any) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="stack fadein"><h1 className="h1-page">Workflows</h1>
      <p className="muted">Enchaînez jusqu'à 8 étapes. Utilisez <code>{'{{input}}'}</code> pour votre texte de départ et <code>{'{{previous}}'}</code> pour le résultat de l'étape précédente. Chaque étape consomme une tâche.</p>
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/workflows', { body: { name, steps } }); setName(''); setSteps([{ type: 'prompt', prompt: '' }]); w.reload(); }); }}>
        <Field label="Nom du workflow"><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} /></Field>
        {steps.map((s, i) => (<div className="card flat" key={i} style={{ marginBottom: 10 }}>
          <div className="row between"><b>Étape {i + 1}</b>{steps.length > 1 && <button type="button" className="btn sm danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Retirer</button>}</div>
          <Field label="Exécutée par"><select value={s.type === 'agent' ? s.agentId ?? '' : ''} onChange={(e) => upd(i, e.target.value ? { type: 'agent', agentId: e.target.value } : { type: 'prompt', agentId: undefined })}><option value="">Assistant par défaut</option>{agents.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
          <Field label="Consigne"><textarea value={s.prompt} onChange={(e) => upd(i, { prompt: e.target.value })} required minLength={2} placeholder={i === 0 ? 'Résume ce texte : {{input}}' : 'Traduis en anglais : {{previous}}'} /></Field></div>))}
        <div className="row">{steps.length < 8 && <button type="button" className="btn" onClick={() => setSteps([...steps, { type: 'prompt', prompt: '' }])}>Ajouter une étape</button>}<button className="btn primary" disabled={a.busy}>Enregistrer</button></div><Err error={a.error} /></form>
      {list.map((x: any) => (<div className="card" key={x.id}><div className="row between"><h3 style={{ margin: 0 }}>{x.name} <span className="tiny">({x.steps.length} étape{x.steps.length > 1 ? 's' : ''})</span></h3>
        <div className="row"><button className="btn sm primary" onClick={() => { setRun({ id: x.id, input: '' }); setResult(null); }}>Lancer</button><button className="btn sm danger" onClick={async () => { await api(`/api/workflows/${x.id}`, { method: 'DELETE' }); w.reload(); }}>Supprimer</button></div></div>
        {run?.id === x.id && (<form style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); r.run(async () => setResult(await api(`/api/workflows/${x.id}/run`, { body: { input: run.input } }))); }}>
          <Field label="Texte de départ"><textarea value={run.input} onChange={(e) => setRun({ id: x.id, input: e.target.value })} required /></Field>
          <button className="btn primary" disabled={r.busy}>{r.busy ? 'En cours…' : `Lancer (${x.steps.length} tâche${x.steps.length > 1 ? 's' : ''})`}</button><Err error={r.error} />
          {result && <div className="card flat" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}><b>Résultat</b><p>{result.output}</p>{result.log?.some((l: any) => l.error) && <Alert kind="warn">Une étape a échoué : {result.log.find((l: any) => l.error)?.error}</Alert>}</div>}</form>)}</div>))}
      {list.length === 0 && !w.loading && <p className="muted">Aucun workflow.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Marketplace */
export function Marketplace() {
  const [q, setQ] = useState(''); const l = useAsync(() => api(`/api/marketplace${q ? `?q=${encodeURIComponent(q)}` : ''}`), [q]); const mine = useAsync(() => api('/api/marketplace/mine'));
  const ag = useAsync(() => api('/api/agents').catch(() => ({ agents: [] }))); const wf = useAsync(() => api('/api/workflows').catch(() => ({ workflows: [] })));
  const [f, setF] = useState({ kind: 'agent', refId: '', title: '', description: '' }); const a = useAction(); const i = useAction();
  const items = ((f.kind === 'agent' ? (ag.data as any)?.agents : (wf.data as any)?.workflows) ?? []) as any[];
  return (
    <div className="stack fadein"><h1 className="h1-page">Marketplace</h1>
      <p className="muted">Agents et workflows partagés par la communauté. Chaque publication est relue avant d'apparaître. Seules les consignes sont partagées, jamais vos documents ni votre mémoire.</p>
      <input aria-label="Rechercher" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
      {i.ok && <Alert kind="ok">{i.ok}</Alert>}<Err error={i.error || l.error} />
      <div className="grid">{((l.data as any)?.listings ?? []).map((x: any) => <div className="card" key={x.id}><span className="chip">{x.kind === 'agent' ? 'Agent' : 'Workflow'}</span><h3 style={{ marginTop: 8 }}>{x.title}</h3><p className="muted">{x.description}</p><div className="row between"><span className="tiny">{x.installs} installation(s)</span>
        <button className="btn sm primary" disabled={i.busy} onClick={() => i.run(() => api(`/api/marketplace/${x.id}/install`, { method: 'POST', body: {} }), 'Ajouté à votre espace.')}>Installer</button></div></div>)}</div>
      {!l.loading && ((l.data as any)?.listings ?? []).length === 0 && <p className="muted">Aucune annonce pour l'instant.</p>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/marketplace', { body: f }); setF({ ...f, title: '', description: '', refId: '' }); mine.reload(); }, 'Envoyé pour relecture.'); }}>
        <h3>Publier une création</h3>
        <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, refId: '' })}><option value="agent">Agent</option><option value="workflow">Workflow</option></select></Field>
        <Field label="Création à publier"><select required value={f.refId} onChange={(e) => setF({ ...f, refId: e.target.value })}><option value="">Choisir…</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Titre"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={80} /></Field>
        <Field label="Description"><textarea required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={400} /></Field>
        <Err error={a.error} />{a.ok && <Alert kind="ok">{a.ok}</Alert>}<button className="btn primary" disabled={a.busy}>Envoyer pour relecture</button></form>
      <div className="card"><h3>Mes publications</h3><Table head={['Titre', 'Type', 'État', 'Installations']} rows={((mine.data as any)?.listings ?? []).map((x: any) => [x.title, x.kind, <StatusChip key="s" s={x.status} />, x.installs])} empty="Vous n'avez rien publié." /></div>
    </div>
  );
}

/* ------------------------------------------------------------------ TikTok */
export function TikTok({ me }: { me: Me }) {
  const acc = useAsync(() => api('/api/tiktok/accounts')); const [sel, setSel] = useState<string | null>(null); const [handle, setHandle] = useState(''); const [cat, setCat] = useState(''); const a = useAction();
  const list = (acc.data as any)?.accounts ?? [];
  useEffect(() => { if (!sel && list[0]) setSel(list[0].id); }, [list, sel]);
  return (
    <div className="stack fadein"><h1 className="h1-page">Analyse TikTok</h1>
      <Alert>Cette analyse utilise les chiffres que vous saisissez, importez en CSV, ou récupérez automatiquement si vous avez connecté votre compte TikTok (offre Social, via l'autorisation officielle TikTok). Aucune donnée de tendances externe, aucune garantie de vues ni de revenus.</Alert>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api('/api/tiktok/accounts', { body: { handle, country: me.user.country ?? undefined, category: cat || undefined } }); setHandle(''); setSel(r.id); acc.reload(); }); }}>
        <input className="grow" aria-label="Identifiant TikTok" placeholder="@moncompte" value={handle} onChange={(e) => setHandle(e.target.value)} required /><input className="grow" aria-label="Catégorie" placeholder="Catégorie (mode, cuisine…)" value={cat} onChange={(e) => setCat(e.target.value)} /><button className="btn primary" disabled={a.busy}>Suivre ce compte</button></form>
      <Err error={a.error || acc.error} />
      {list.length > 0 && <div className="tabs" role="tablist">{list.map((x: any) => <a key={x.id} href="#/app/tiktok" role="tab" aria-selected={sel === x.id} className={sel === x.id ? 'on' : ''} onClick={(e) => { e.preventDefault(); setSel(x.id); }}>@{x.handle}</a>)}</div>}
      {sel && <TikTokAccount key={sel} id={sel} me={me} onDelete={() => { setSel(null); acc.reload(); }} />}
    </div>
  );
}
const CSV_EXAMPLE = 'date;legende;vues;likes;commentaires;partages;format;duree_s\n2026-09-01 18:30;Ma nouvelle collection #mode #abidjan;12400;980;45;120;vidéo;24';
function TikTokAccount({ id, me, onDelete }: { id: string; me: Me; onDelete: () => void }) {
  const [csv, setCsv] = useState(''); const [fol, setFol] = useState(''); const [res, setRes] = useState<any>(null); const a = useAction(); const b = useAction(); const c = useAction(); const imp = useAction();
  const social = useAsync(() => api('/api/social/accounts').catch(() => ({ accounts: [] })));
  const connected = ((social.data as any)?.accounts ?? []).find((x: any) => x.platform === 'tiktok');
  const analyze = () => c.run(async () => setRes(await api(`/api/tiktok/accounts/${id}/analyze`, { body: { advanced: true, tzOffsetMinutes: -new Date().getTimezoneOffset() } })));
  const adv = res?.advanced;
  return (
    <div className="stack">
      <div className="card">
        <h3>1. Ajouter vos vidéos</h3>
        {connected ? (<>
          <p className="muted">Compte TikTok connecté : <b>{connected.displayName}</b>. Importez vos vraies statistiques en un clic, sans copier-coller.</p>
          <button className="btn primary" disabled={imp.busy} onClick={() => imp.run(async () => { const r = await api(`/api/tiktok/accounts/${id}/import-connected`, { body: {} }); return r; }, 'Statistiques réelles importées.')}>Importer depuis mon compte TikTok connecté</button>
          <Err error={imp.error} />{imp.ok && <Alert kind="ok">{imp.ok}</Alert>}
          <p className="tiny" style={{ marginTop: 10 }}>Ou collez un tableau CSV à la place :</p>
        </>) : (<p className="muted">Collez un tableau CSV (une ligne par vidéo), ou <a href="#/app/reseaux">connectez votre compte TikTok</a> (offre Social) pour importer vos vraies statistiques automatiquement. Colonnes obligatoires : date et vues.</p>)}
        <textarea aria-label="Données CSV" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_EXAMPLE} style={{ minHeight: 120, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '.85rem' }} />
        <div className="row" style={{ marginTop: 8 }}><label className="btn sm">Charger un fichier .csv<input type="file" accept=".csv,text/csv,text/plain" className="sr" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} /></label>
          <button className="btn primary" disabled={a.busy || !csv.trim()} onClick={() => a.run(async () => { const r = await api(`/api/tiktok/accounts/${id}/posts`, { body: { csv } }); setCsv(''); return r; }, 'Vidéos ajoutées.')}>Importer le CSV</button></div>
        <Err error={a.error} />{a.ok && <Alert kind="ok">{a.ok}</Alert>}</div>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); b.run(async () => { await api(`/api/tiktok/accounts/${id}/snapshots`, { body: { followers: Number(fol) } }); setFol(''); }, 'Relevé enregistré.'); }}>
        <div className="grow"><h3>2. Relever vos abonnés</h3><input type="number" min={0} aria-label="Nombre d'abonnés" placeholder="Abonnés aujourd'hui" value={fol} onChange={(e) => setFol(e.target.value)} required /></div><button className="btn" disabled={b.busy}>Enregistrer</button>
        <div style={{ flexBasis: '100%' }}><Err error={b.error} />{b.ok && <Alert kind="ok">{b.ok}</Alert>}</div></form>
      <div className="card"><h3>3. Analyser</h3><div className="row"><button className="btn primary" disabled={c.busy} onClick={analyze}>{c.busy ? 'Analyse…' : 'Lancer l\'analyse (1 tâche)'}</button>
        <button className="btn danger sm" onClick={async () => { if (confirm('Supprimer ce compte et toutes ses données ?')) { await api(`/api/tiktok/accounts/${id}`, { method: 'DELETE' }); onDelete(); } }}>Supprimer ce compte</button></div><Err error={c.error} /></div>
      {res && (<div className="card stack"><h3>Résultats de base</h3>
        <div className="grid">{[['Vidéos', res.basic.posts], ['Vues moyennes', fmtNum(res.basic.avgViews)], ['Engagement', `${res.basic.engagementRatePct} %`], ['Rythme', `${res.basic.postsPerWeek} / sem.`]].map(([k, v]) => <div className="kpi card flat" key={String(k)}><span className="tiny">{k}</span><b>{v}</b></div>)}</div>
        {res.growth && <p>Abonnés : {fmtNum(res.growth.from.followers)} → {fmtNum(res.growth.to.followers)} ({res.growth.delta >= 0 ? '+' : ''}{fmtNum(res.growth.delta)}) entre le {res.growth.from.taken_on} et le {res.growth.to.taken_on}.</p>}
        <Table head={['Vidéo', 'Vues', 'Engagement']} rows={res.basic.topPosts.map((p: any) => [p.caption || fmtDate(p.postedAt), fmtNum(p.views), `${p.engagementPct} %`])} />
        {res.advancedLocked && <Alert kind="warn">L'analyse avancée (meilleurs jours, créneaux, formats, hashtags) est incluse dans l'offre TikTok Pro. <a href="#/offres">Voir les offres</a></Alert>}
        {adv && (<><h3>Analyse avancée</h3>
          {adv.byWeekday.length > 0 && <><h4 style={{ margin: 0 }}>Vues moyennes par jour de publication</h4><Bars label="Vues moyennes par jour" data={adv.byWeekday.map((x: any) => ({ k: x.key, v: x.avgViews }))} /></>}
          {adv.byHour.length > 0 && <><h4 style={{ margin: 0 }}>Vues moyennes par heure de publication</h4><Bars label="Vues moyennes par heure" data={adv.byHour.map((x: any) => ({ k: x.key, v: x.avgViews }))} /></>}
          <ul>{adv.recommendations.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
          {adv.suggestedHashtags && <p><b>Hashtags à tester :</b> {adv.suggestedHashtags.items.join(' ')}<br /><span className="tiny">{adv.suggestedHashtags.note}</span></p>}
          <p className="tiny">{adv.marketTrendsNote}</p></>)}
        <p className="tiny">{res.limits}</p></div>)}
    </div>
  );
}

/* ------------------------------------------------------------------ Offres et paiement */
export function Pricing({ me, cfg, reload }: { me: Me; cfg: any; reload: () => void }) {
  const [country, setCountry] = useState(me.user.country ?? '');
  const p = useAsync(() => api(`/api/plans${country ? `?country=${country}` : ''}`), [country]); const [method, setMethod] = useState(''); const [plan, setPlan] = useState(''); const a = useAction();
  const d: any = p.data; const methods = (d?.methods ?? []) as any[];
  const isPack = (x: any) => (x.features ?? []).some((f: string) => f.startsWith('tokens:')); const packs = ((d?.plans ?? []) as any[]).filter(isPack).sort((a, b) => Number(a.features[0].slice(7)) - Number(b.features[0].slice(7)));
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const needsBilling = method === 'card' && d?.currency !== 'EUR';
  const pay = () => a.run(async () => {
    if (country !== me.user.country) await api('/api/account/country', { body: { country } });
    const r = await api('/api/payments/checkout', { body: { planCode: plan, country, method, billing: needsBilling ? { name, phone } : undefined } });
    location.href = r.paymentUrl;
  });
  return (
    <div className="stack fadein"><h1 className="h1-page">Offres</h1>
      {cfg?.demoMode && <Alert kind="warn">Mode démonstration : aucun vrai paiement n'est effectué.</Alert>}
      <Field label="Votre pays"><select value={country} onChange={(e) => { setCountry(e.target.value); setMethod(''); }}><option value="">Choisir…</option>{(cfg?.countries ?? []).map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
      {!country && <p className="muted">Choisissez votre pays pour voir les prix et les moyens de paiement.</p>}
      {country && d && (<>
        <div className="grid">{d.plans.filter((x: any) => !isPack(x)).map((x: any) => (<button key={x.code} type="button" className={`card pick ${plan === x.code ? 'sel' : ''}`} onClick={() => setPlan(x.code)} aria-pressed={plan === x.code}>
          <h3>{x.name}</h3><p className="muted">{x.description}</p><div className="bignum sm">{x.price ? fmtMoney(x.price.amount, x.price.currency) : 'Prix indisponible'}</div><p className="tiny">pour {x.durationDays} jours, sans renouvellement automatique</p></button>))}</div>
        <h3>Jetons <span className="tiny">(1 jeton = 1 tâche IA · sans date d'expiration · consommés après votre abonnement et vos essais gratuits)</span></h3>
        <p className="tiny" style={{ marginTop: -6 }}>Solde actuel : <b>{fmtNum(me.entitlements.tokens ?? 0)}</b> jeton(s). Vous êtes prévenu par email quand il vous en reste 10 puis 0.</p>
        <div className="grid">{packs.map((x: any) => { const n = Number(x.features[0].slice(7)); return (<button key={x.code} type="button" className={`card pick ${plan === x.code ? 'sel' : ''}`} onClick={() => setPlan(x.code)} aria-pressed={plan === x.code}>
          <h3>{fmtNum(n)} jetons</h3><div className="bignum sm">{x.price ? fmtMoney(x.price.amount, x.price.currency) : 'Prix indisponible'}</div>{x.price && <p className="tiny" style={{ margin: 0 }}>{(x.price.amount / n).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} {x.price.currency} le jeton</p>}</button>); })}</div>
        <h3>Moyen de paiement</h3>
        <div role="radiogroup" aria-label="Moyen de paiement">{methods.map((m) => <div key={m.id} role="radio" aria-checked={method === m.id} aria-disabled={!m.available} tabIndex={m.available ? 0 : -1} className={`method ${method === m.id ? 'sel' : ''} ${m.available ? '' : 'off'}`} onClick={() => m.available && setMethod(m.id)} onKeyDown={(e) => { if (m.available && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setMethod(m.id); } }}>
          <b>{m.label}</b>{!m.available && <span className="tiny">{m.note}</span>}</div>)}</div>
        {needsBilling && <div className="card flat"><p className="tiny">Le paiement par carte demande ces informations à l'agrégateur.</p><Field label="Nom complet"><input value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Téléphone"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field></div>}
        {!me.user.emailVerified && <Alert kind="warn">Confirmez votre adresse email avant de payer.</Alert>}<Err error={a.error} />
        <button className="btn primary" disabled={!plan || !method || a.busy || !me.user.emailVerified} onClick={pay}>{a.busy ? 'Redirection…' : 'Payer'}</button>
        <p className="tiny">Vous serez redirigé vers la page de paiement sécurisée de notre prestataire (CinetPay ou Stripe). Le prélèvement SEPA peut prendre quelques jours à être confirmé. Votre offre est activée seulement après confirmation du paiement par le serveur.</p></>)}
      <PaymentHistory />
    </div>
  );
}
function PaymentHistory() {
  const h = useAsync(() => api('/api/payments/history'));
  return <div className="card"><h3>Mes paiements</h3><Table head={['Date', 'Offre', 'Montant', 'État']} rows={((h.data as any)?.payments ?? []).map((x: any) => [fmtDate(x.created_at), x.plan_code, fmtMoney(x.amount, x.currency), <StatusChip key="s" s={x.status} />])} empty="Aucun paiement." /></div>;
}
export function PaymentReturn({ ref_, reload }: { ref_: string; reload: () => void }) {
  const [s, setS] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let n = 0, live = true; const tick = async () => { try { const r = await api(`/api/payments/${encodeURIComponent(ref_)}`); if (!live) return; setS(r); if (r.status === 'pending' && n++ < 20) setTimeout(tick, 3000); else reload(); } catch (e: any) { setErr(e.message); } }; tick(); return () => { live = false; }; /* eslint-disable-next-line */ }, [ref_]);
  return (<div className="wrap" style={{ maxWidth: 520 }}><div className="card stack"><h2>Votre paiement</h2>
    {err && <Alert kind="err">{err}</Alert>}{!s && !err && <Loading />}
    {s?.status === 'pending' && <Alert>Paiement en attente de confirmation… Cette page se met à jour toute seule. Si vous avez payé, patientez quelques instants.</Alert>}
    {s?.status === 'succeeded' && <Alert kind="ok">Paiement confirmé : {fmtMoney(s.amount, s.currency)}. Votre offre est active.</Alert>}
    {s && ['failed', 'cancelled', 'expired'].includes(s.status) && <Alert kind="err">Le paiement n'a pas abouti (statut : {s.status}). Vous n'avez pas été débité par Velyra AI ; si une somme a été prélevée, contactez le support avec la référence {s.ref}.</Alert>}
    <p className="tiny">Référence : {ref_}</p><a className="btn primary" href="#/app">Retour à mon espace</a></div></div>);
}

/* ------------------------------------------------------------------ Développeurs */
export function Developer() {
  const k = useAsync(() => api('/api/keys')); const [name, setName] = useState(''); const [created, setCreated] = useState<string | null>(null); const a = useAction();
  const base = (window.__API_BASE__ || location.origin);
  return (
    <div className="stack fadein"><h1 className="h1-page">API pour développeurs</h1>
      <p className="muted">Appelez Velyra AI depuis votre propre application. Chaque appel de chat consomme une tâche de votre compte. Limite : 60 requêtes par minute et par clé.</p>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api('/api/keys', { body: { name } }); setCreated(r.key); setName(''); k.reload(); }); }}>
        <input className="grow" aria-label="Nom de la clé" placeholder="Nom de la clé (ex. : mon site)" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /><button className="btn primary" disabled={a.busy}>Créer une clé</button></form>
      <Err error={a.error || k.error} />
      {created && <Alert kind="warn">Copiez cette clé maintenant : elle ne sera plus jamais affichée.<br /><code style={{ wordBreak: 'break-all' }}>{created}</code></Alert>}
      <div className="card"><Table head={['Nom', 'Début', 'Dernier usage', 'État', '']} rows={((k.data as any)?.keys ?? []).map((x: any) => [x.name, `${x.prefix}…`, fmtDate(x.last_used_at), x.revoked_at ? 'révoquée' : 'active', !x.revoked_at && <button key="r" className="btn sm danger" onClick={async () => { await api(`/api/keys/${x.id}`, { method: 'DELETE' }); k.reload(); }}>Révoquer</button>])} empty="Aucune clé." /></div>
      <div className="card"><h3>Exemple</h3><pre>{`curl -X POST ${base}/api/v1/chat \\
  -H "x-api-key: vly_VOTRE_CLE" \\
  -H "content-type: application/json" \\
  -d '{"message":"Bonjour"}'`}</pre><p className="tiny">Spécification : <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">/api/v1/openapi.json</a></p></div>
    </div>
  );
}

/* ------------------------------------------------------------------ Usage */
function UsageHistory() {
  const t = useAsync(() => api('/api/tasks?limit=300'));
  const rows = (t.data as any)?.tasks ?? [];
  if (!t.data) return null;
  const days: { k: string; v: number }[] = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const key = d.toISOString().slice(0, 10); days.push({ k: key.slice(5), v: 0 }); }
  const byDay = new Map(days.map((d) => [d.k, d]));
  for (const r of rows) { const k = String(r.created_at).slice(5, 10); const d = byDay.get(k); if (d) d.v++; }
  const total = rows.length;
  return (
    <div className="card"><h3>Mon usage</h3>
      {total === 0 ? <p className="muted">Aucune tâche effectuée pour l'instant.</p> : (<>
        <p className="muted tiny">Tâches IA effectuées par jour, 14 derniers jours ({total} au total sur les {rows.length < 300 ? rows.length : '300+'} dernières).</p>
        <Bars label="Tâches par jour" data={days} /></>)}
    </div>
  );
}

/* ------------------------------------------------------------------ Compte */
export function Account({ me, reload, onLogout }: { me: Me; reload: () => void; onLogout: () => void }) {
  const s = useAsync(() => api('/api/account/sessions')); const a = useAction(); const del = useAction(); const [pw, setPw] = useState(''); const [open, setOpen] = useState(false); const [code, setCode] = useState('');
  return (
    <div className="stack fadein"><h1 className="h1-page">Mon compte</h1>
      <div className="card"><p><b>{me.user.email}</b></p><p className="muted">Email {me.user.emailVerified ? 'confirmé' : 'non confirmé'} · Téléphone {me.user.phoneVerified ? `confirmé (${me.user.phone})` : 'non confirmé'} · Pays : {me.user.country ?? 'non renseigné'}</p>
        <div className="row"><button className="btn" onClick={() => a.run(() => download('/api/account/export', 'velyra-mes-donnees.json'))}>Exporter mes données</button><button className="btn" onClick={async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined); onLogout(); }}>Se déconnecter</button></div><Err error={a.error} /></div>
      <UsageHistory />
      <div className="card"><div className="row between"><h3>Appareils connectés</h3><button className="btn sm" onClick={async () => { await api('/api/account/sessions/revoke-others', { method: 'POST', body: {} }); s.reload(); }}>Déconnecter les autres</button></div>
        <Table head={['Navigateur', 'Adresse IP', 'Dernière activité', '']} rows={((s.data as any)?.sessions ?? []).map((x: any) => [(x.userAgent || '').slice(0, 50) || '—', x.ip, fmtDate(x.lastSeenAt), x.current ? <span key="c" className="chip good">cet appareil</span> : <button key="r" className="btn sm danger" onClick={async () => { await api(`/api/account/sessions/${x.id}`, { method: 'DELETE' }); s.reload(); }}>Révoquer</button>])} /></div>
      <div className="card"><h3>Supprimer mon compte</h3><p className="muted">Vos conversations, souvenirs, documents et agents sont effacés. Les enregistrements de paiement peuvent être conservés pour des raisons comptables.</p>
        {!open ? <button className="btn danger" onClick={() => setOpen(true)}>Supprimer mon compte…</button> : (
          <form onSubmit={(e) => { e.preventDefault(); del.run(async () => { await api('/api/account/delete', { body: { password: pw, code } }); tokens.setUser(null); onLogout(); }); }}>
            <Field label="Mot de passe (comptes avec mot de passe)"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <div className="row"><button type="button" className="btn sm" onClick={() => del.run(() => api('/api/account/delete-code', { method: 'POST', body: {} }), 'Code envoyé par email (comptes Google).')}>Recevoir un code par email</button><input style={{ maxWidth: 160 }} placeholder="Code" aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} /></div>
            <Err error={del.error} />{del.ok && <Alert kind="ok">{del.ok}</Alert>}<button className="btn danger" disabled={del.busy} style={{ marginTop: 10 }}>Confirmer la suppression définitive</button></form>)}</div>
      <span hidden>{go.length}{reload.length}</span>
    </div>
  );
}
