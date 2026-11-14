import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, download } from './api';
import { Alert, AreaTrend, Bars, CountUp, Donut, Err, Field, Loading, Ring, Table, fmtDate, fmtNum, go, useAction, useAsync } from './ui';

export interface Me { user: any; entitlements: any; region: string | null; currency: string | null; todo: string[] }

const KIND_LABEL: Record<string, string> = { chat: 'Conversations IA', workflow_step: 'Étapes de workflow', tiktok_analysis: 'Analyses TikTok' };
const label = (k: string) => KIND_LABEL[k] ?? k;

function IconChat() { return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 5.5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 11.5v-6Z" strokeLinejoin="round" /></svg>; }
function IconTrend() { return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 15.5 8 9l3.2 3.2L17 5" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.5 5H17v4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function IconDocs() { return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 2.5h5.5L15 6v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" strokeLinejoin="round" /><path d="M11.5 2.5V6H15" strokeLinejoin="round" /><path d="M7.5 10.5h5M7.5 13h5" strokeLinecap="round" /></svg>; }
function IconArrow() { return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" width={15} height={15}><path d="M5 15 15 5M8 5h7v7" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

/* ------------------------------------------------------------------ Tableau de bord + démarrage */
export function Dashboard({ me, cfg, reload }: { me: Me; cfg: any; reload: () => void }) {
  const e = me.entitlements; const pct = Math.round((e.trialsRemaining / e.trialsTotal) * 100);
  const t = useAsync(() => api('/api/tasks?limit=300'));
  const tasks: any[] = (t.data as any)?.tasks ?? [];

  // Tendance sur 14 jours, calculée côté client à partir des tâches déjà chargées — aucune requête supplémentaire.
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return d.toISOString().slice(0, 10); });
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  for (const x of tasks) { const d = String(x.created_at).slice(0, 10); if (d in byDay) byDay[d]++; }
  const trend = days.map((d) => ({ k: new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }), v: byDay[d] }));
  const trendTotal = trend.reduce((s, d) => s + d.v, 0);

  // Répartition réelle par type de tâche — seulement affichée s'il y a effectivement de quoi la montrer.
  const byKind: Record<string, number> = {};
  for (const x of tasks) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
  const breakdown = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k: label(k), v }));

  let i = 0; const d = () => ({ '--d': i++ } as CSSProperties);
  return (
    <div className="stack fadein">
      <h1 style={{ fontSize: '1.6rem' }}>Bonjour</h1>
      {me.todo.length > 0 && <Onboarding me={me} cfg={cfg} reload={reload} />}

      <div className="grid">
        <div className="card stagger row" style={d()}>
          {e.platformAccess ? (
            <Ring pct={100} big="Abonné" small="actif" />
          ) : (
            <Ring pct={pct} big={<CountUp value={e.trialsRemaining} />} small={`/ ${e.trialsTotal} essais`} />
          )}
          <div style={{ flex: 1, minWidth: 140 }}>
            {e.platformAccess ? <p className="muted" style={{ margin: 0 }}>Accès complet jusqu'au {fmtDate(e.subscriptions[0]?.endsAt)}. Usage équitable : 300 tâches par jour.</p>
              : <>
                <p className="muted" style={{ margin: 0 }}>tâches d'essai gratuites restantes</p>
                {e.trialsRemaining === 0 && <p style={{ marginTop: 10 }}><a className="btn primary sm" href="#/offres">Choisir une offre</a></p>}
              </>}
          </div>
        </div>
        <a className="card stagger" style={d()} href="#/offres">
          <div className="bignum"><CountUp value={e.tokens ?? 0} /></div>
          <p className="muted" style={{ margin: 0 }}>jetons (sans expiration) · <span style={{ color: 'var(--gold)', fontWeight: 650 }}>recharger →</span></p>
        </a>
      </div>

      <div className="grid">
        <a className="card action-card stagger" style={d()} href="#/app/chat"><span className="glyph"><IconChat /></span><h3>Discuter avec l'IA</h3><p className="muted" style={{ margin: 0 }}>Une tâche par message envoyé.</p><span className="go"><IconArrow /></span></a>
        <a className="card action-card stagger" style={d()} href="#/app/tiktok"><span className="glyph"><IconTrend /></span><h3>Analyser mon TikTok</h3><p className="muted" style={{ margin: 0 }}>Avec vos propres chiffres, sans connexion à TikTok.</p><span className="go"><IconArrow /></span></a>
        <a className="card action-card stagger" style={d()} href="#/app/documents"><span className="glyph"><IconDocs /></span><h3>Mes documents</h3><p className="muted" style={{ margin: 0 }}>Importez du texte, puis cherchez dedans.</p><span className="go"><IconArrow /></span></a>
      </div>

      {trendTotal > 0 && (
        <div className="card stagger" style={d()}>
          <div className="row between"><h3>Activité — 14 derniers jours</h3><span className="tiny">{trendTotal} tâche{trendTotal > 1 ? 's' : ''}</span></div>
          <AreaTrend label="Tâches par jour" data={trend} />
        </div>
      )}

      {breakdown.length > 1 && (
        <div className="card stagger" style={d()}>
          <h3>Répartition par type</h3>
          <Donut label="Répartition des tâches par type" data={breakdown} />
        </div>
      )}

      <div className="stagger" style={d()}><RecentTasks tasks={tasks} loading={t.loading} /></div>
    </div>
  );
}

function RecentTasks({ tasks, loading }: { tasks: any[]; loading: boolean }) {
  if (loading && !tasks.length) return <div className="card"><Loading /></div>;
  return <div className="card"><h3>Activité récente</h3><Table head={['Date', 'Service', 'Facturation', 'État']} rows={tasks.slice(0, 8).map((x: any) => [fmtDate(x.created_at), label(x.kind), x.billing === 'trial' ? 'essai gratuit' : 'abonnement', x.status])} empty="Aucune tâche pour l'instant. Envoyez votre premier message à l'IA." /></div>;
}

function Onboarding({ me, cfg, reload }: { me: Me; cfg: any; reload: () => void }) {
  return (
    <div className="card stack" style={{ borderColor: 'var(--mango)' }}>
      <h2>Terminez l'activation de votre compte</h2>
      <p className="muted">Ces étapes servent à protéger les essais gratuits contre les abus.</p>
      {me.todo.includes('verify_email') && <EmailStep reload={reload} />}
      {me.todo.includes('verify_phone') && <PhoneStep reload={reload} blocked={me.todo.includes('verify_email')} />}
      {me.todo.includes('set_country') && <CountryStep cfg={cfg} reload={reload} />}
    </div>
  );
}
function EmailStep({ reload }: { reload: () => void }) {
  const [code, setCode] = useState(''); const a = useAction(); const r = useAction();
  return (<form className="card flat" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/auth/verify-email', { body: { code } }); reload(); }); }}>
    <h3>1. Confirmer votre email</h3><p className="muted">Saisissez le code à 6 chiffres reçu par email (valable 10 minutes).</p>
    <div className="row"><input className="grow" inputMode="numeric" autoComplete="one-time-code" aria-label="Code email" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} /><button className="btn primary" disabled={a.busy}>Valider</button>
      <button type="button" className="btn" disabled={r.busy} onClick={() => r.run(() => api('/api/auth/resend-email', { method: 'POST', body: {} }), 'Nouveau code envoyé.')}>Renvoyer le code</button></div>
    <Err error={a.error || r.error} />{r.ok && <Alert kind="ok">{r.ok}</Alert>}</form>);
}
function PhoneStep({ reload, blocked }: { reload: () => void; blocked: boolean }) {
  const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [sent, setSent] = useState(false); const a = useAction();
  return (<div className="card flat" style={blocked ? { opacity: .6 } : undefined}>
    <h3>2. Confirmer votre téléphone</h3><p className="muted">Un SMS avec un code sera envoyé. Un numéro ne peut activer qu'un seul compte.</p>
    {!sent ? (<form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/account/phone/send', { body: { phone } }); setSent(true); }); }}>
      <input className="grow" type="tel" autoComplete="tel" placeholder="+225 07 00 00 00 00" aria-label="Numéro de téléphone" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={blocked} /><button className="btn primary" disabled={a.busy || blocked}>Recevoir le SMS</button></form>)
      : (<form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/account/phone/verify', { body: { code } }); reload(); }); }}>
        <input className="grow" inputMode="numeric" autoComplete="one-time-code" aria-label="Code SMS" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} /><button className="btn primary" disabled={a.busy}>Valider</button></form>)}
    <Err error={a.error} /></div>);
}
function CountryStep({ cfg, reload }: { cfg: any; reload: () => void }) {
  const [c, setC] = useState(''); const a = useAction();
  return (<div className="card flat"><h3>3. Votre pays</h3><p className="muted">Il détermine la devise et les moyens de paiement proposés.</p>
    <div className="row"><select className="grow" aria-label="Pays" value={c} onChange={(e) => setC(e.target.value)}><option value="">Choisir…</option>{(cfg?.countries ?? []).map((x: any) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
      <button className="btn primary" disabled={!c || a.busy} onClick={() => a.run(async () => { await api('/api/account/country', { body: { country: c } }); reload(); })}>Enregistrer</button></div><Err error={a.error} /></div>);
}

/* ------------------------------------------------------------------ Chat */
const EXAMPLES = [
  'Propose-moi 3 idées de campagne pour lancer un nouveau produit à Abidjan.',
  'Rédige une réponse polie à un client qui se plaint d\'une livraison en retard.',
  'Résume ce texte en 3 points pour une story Instagram : [collez votre texte]',
  'Explique-moi la différence entre un statut d\'entreprise individuelle et une SARL en Côte d\'Ivoire.',
];

/** Indicateur honnête : affiche les étapes réellement en cours, avec un chronomètre qui compte le temps écoulé réel — jamais un minuteur fixe qui tourne sans travail derrière. */
function ThinkingStatus({ useDocs }: { useDocs: boolean }) {
  const [s, setS] = useState(0);
  useEffect(() => { const t = setInterval(() => setS((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const label = useDocs ? (s < 2 ? 'Recherche dans vos documents et votre mémoire…' : 'Le modèle rédige la réponse…') : 'Le modèle rédige la réponse…';
  return <div className="bubble a muted row" style={{ gap: 8 }}><span aria-hidden="true">⏳</span><span>{label} <span className="tiny">({s}s)</span></span></div>;
}
function StepsDetail({ steps }: { steps?: { label: string; ms: number }[] }) {
  if (!steps?.length) return null;
  const total = steps.reduce((a2, s) => a2 + s.ms, 0);
  return <p className="tiny" style={{ margin: '4px 0 0' }}>{steps.map((s) => `${s.label} (${(s.ms / 1000).toFixed(1)}s)`).join(' · ')} — total {(total / 1000).toFixed(1)}s</p>;
}

export function Chat({ reload }: { reload: () => void }) {
  const convs = useAsync(() => api('/api/conversations'));
  const agents = useAsync(() => api('/api/agents').catch(() => ({ agents: [] })));
  const [cid, setCid] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<{ role: string; content: string; steps?: { label: string; ms: number }[] }[]>([]);
  const [text, setText] = useState(''); const [agentId, setAgentId] = useState(''); const [useDocs, setUseDocs] = useState(false); const a = useAction(); const [paywall, setPaywall] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  const open = async (id: string | null) => { setCid(id); setPaywall(false); if (!id) return setMsgs([]); const c = await api(`/api/conversations/${id}`); setMsgs(c.messages); setAgentId(c.agent_id ?? ''); };
  const send = (e: React.FormEvent, override?: string) => { e.preventDefault(); const m = (override ?? text).trim(); if (!m) return;
    a.run(async () => {
      setMsgs((x) => [...x, { role: 'user', content: m }]); setText('');
      try { const r = await api('/api/chat', { body: { message: m, conversationId: cid ?? undefined, agentId: agentId || undefined, useDocuments: useDocs } });
        setCid(r.conversationId); setMsgs((x) => [...x, { role: 'assistant', content: r.reply, steps: r.steps }]); convs.reload(); reload();
      } catch (err: any) { if (err.code === 'trial_exhausted') setPaywall(true); setMsgs((x) => x.slice(0, -1)); setText(m); throw err; }
    }); };
  const list = (convs.data as any)?.conversations ?? [];
  return (
    <div className="chat fadein">
      <aside className="card" style={{ alignSelf: 'start' }}>
        <button className="btn primary" style={{ width: '100%' }} onClick={() => open(null)}>Nouvelle conversation</button>
        <div className="stack" style={{ marginTop: 12 }}>{list.length === 0 && <p className="tiny">Aucune conversation.</p>}
          {list.map((c: any) => <div key={c.id} className="row between"><button className="btn sm grow" style={{ justifyContent: 'flex-start', fontWeight: c.id === cid ? 800 : 500, overflow: 'hidden' }} onClick={() => open(c.id)}>{c.title || 'Sans titre'}</button>
            <button className="btn sm" aria-label={`Télécharger ${c.title}`} title="Télécharger" onClick={() => download(`/api/conversations/${c.id}/export`, `conversation-${(c.title || 'sans-titre').replace(/[^\w.\-]+/g, '_').slice(0, 40)}.txt`)}>⭳</button>
            <button className="btn sm danger" aria-label={`Supprimer ${c.title}`} onClick={async () => { await api(`/api/conversations/${c.id}`, { method: 'DELETE' }); if (c.id === cid) open(null); convs.reload(); }}>×</button></div>)}</div>
      </aside>
      <section className="card">
        <div className="chatlog convo" aria-live="polite">
          {msgs.length === 0 && !a.busy && (<div className="stack">
            <p className="muted">Posez votre première question. Chaque message envoyé consomme une tâche. Quelques idées pour commencer :</p>
            {EXAMPLES.map((ex) => <button key={ex} type="button" className="btn sm" style={{ textAlign: 'left', justifyContent: 'flex-start', whiteSpace: 'normal', height: 'auto', padding: '8px 12px' }} onClick={(e) => send(e as any, ex)}>{ex}</button>)}
          </div>)}
          {msgs.map((m, i) => (<div key={i}><div className={`bubble ${m.role === 'user' ? 'u' : 'a'}`}>{m.content}</div>{m.role === 'assistant' && <StepsDetail steps={m.steps} />}</div>))}
          {a.busy && <ThinkingStatus useDocs={useDocs} />}<div ref={end} />
        </div>
        {paywall && <Alert kind="warn">Vos essais gratuits sont épuisés. <a href="#/offres">Voir les offres</a></Alert>}
        {!paywall && <Err error={a.error} />}
        <form onSubmit={send} style={{ marginTop: 10 }}>
          <textarea aria-label="Votre message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e as any); }} placeholder="Écrivez votre message…" maxLength={6000} />
          <div className="row between" style={{ marginTop: 8 }}>
            <div className="row">
              <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ width: 'auto' }}><option value="">Assistant par défaut</option>{((agents.data as any)?.agents ?? []).map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
              <label className="row tiny"><input type="checkbox" checked={useDocs} onChange={(e) => setUseDocs(e.target.checked)} /> Utiliser mes documents</label>
            </div>
            <button className="btn primary" disabled={a.busy || !text.trim()}>Envoyer</button>
          </div>
          <p className="tiny" style={{ margin: '8px 0 0' }}>Les réponses d'une IA peuvent contenir des erreurs : vérifiez les informations importantes. Le temps de réponse dépend du modèle connecté et affiche les étapes réellement exécutées, pas un délai fixe.</p>
        </form>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ Mémoire */
export function Memory() {
  const m = useAsync(() => api('/api/memories')); const [t, setT] = useState(''); const a = useAction();
  const list = (m.data as any)?.memories ?? [];
  return (
    <div className="stack fadein"><h1 style={{ fontSize: '1.5rem' }}>Mémoire</h1>
      <p className="muted">Ce que l'assistant doit savoir de vous d'une conversation à l'autre. Il n'enregistre rien tout seul : tout vient de vous. {list.length}/100.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/memories', { body: { content: t } }); setT(''); m.reload(); }); }}>
        <input className="grow" aria-label="Nouveau souvenir" placeholder="Ex. : Je vends des pagnes à Abidjan." value={t} onChange={(e) => setT(e.target.value)} maxLength={500} /><button className="btn primary" disabled={a.busy || t.trim().length < 2}>Ajouter</button></form>
      <Err error={a.error || m.error} />
      {list.length === 0 && !m.loading && <p className="muted">Aucun souvenir.</p>}
      {list.map((x: any) => <div className="card row between" key={x.id}><span>{x.content}</span><button className="btn sm danger" onClick={async () => { await api(`/api/memories/${x.id}`, { method: 'DELETE' }); m.reload(); }}>Effacer</button></div>)}
    </div>
  );
}

/* ------------------------------------------------------------------ Documents + recherche */
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = reject; r.readAsDataURL(f); });
}
const DOCS_PAGE = 50;
export function Documents() {
  const [shown, setShown] = useState(DOCS_PAGE);
  const d = useAsync(() => api(`/api/documents?limit=${shown}`), [shown]); const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const a = useAction();
  const u = useAction(); const [fileName, setFileName] = useState('');
  const [q, setQ] = useState(''); const [hits, setHits] = useState<any[] | null>(null); const [engine, setEngine] = useState<string | null>(null); const [semantic, setSemantic] = useState(false); const [semAvail, setSemAvail] = useState(false); const s = useAction();
  const list = (d.data as any)?.documents ?? []; const total = (d.data as any)?.total ?? list.length;
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f) return; setFileName(f.name);
    u.run(async () => { const dataBase64 = await fileToBase64(f); await api('/api/documents/upload', { body: { title: f.name, filename: f.name, mime: f.type, dataBase64 } }); setFileName(''); d.reload(); }, `« ${f.name} » importé.`);
    e.target.value = ''; };
  return (
    <div className="stack fadein"><h1 style={{ fontSize: '1.5rem' }}>Documents</h1>
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/documents', { body: { title, content } }); setTitle(''); setContent(''); d.reload(); }); }}>
        <h3>Ajouter un texte</h3>
        <Field label="Titre"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required /></Field>
        <Field label="Contenu" hint="Collez du texte, ou importez un fichier PDF/Word ci-dessous."><textarea value={content} onChange={(e) => setContent(e.target.value)} required style={{ minHeight: 140 }} /></Field>
        <Err error={a.error} /><button className="btn primary" disabled={a.busy}>Enregistrer</button></form>
      <div className="card">
        <h3>Importer un fichier</h3>
        <p className="muted tiny">PDF et Word (.docx) : le texte en est extrait automatiquement. Les PDF scannés sans texte (image pure) ne sont pas pris en charge — aucune reconnaissance de caractères n'est faite.</p>
        <label className="btn">{fileName || 'Choisir un fichier PDF ou Word…'}<input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr" onChange={upload} disabled={u.busy} /></label>
        {u.busy && <p className="tiny" style={{ marginTop: 8 }}>Extraction du texte en cours…</p>}<Err error={u.error} />{u.ok && <Alert kind="ok">{u.ok}</Alert>}
      </div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); s.run(async () => { const r = await api(`/api/search?q=${encodeURIComponent(q)}${semantic ? '&mode=semantic' : ''}`); setHits(r.hits); setEngine(r.engine); setSemAvail(!!r.semanticAvailable); }); }}>
        <h3>Rechercher dans mes documents</h3><div className="row"><input className="grow" aria-label="Recherche" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mots-clés ou question" /><button className="btn" disabled={s.busy || !q.trim()}>Chercher</button></div>
        <label className="row tiny" style={{ marginTop: 8 }}><input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} /> Recherche sémantique (par sens, si disponible)</label>
        <p className="tiny">{engine === 'semantic-embeddings' ? 'Résultats obtenus par recherche sémantique (similarité de sens).' : engine === 'bm25-lexical' && semantic ? 'Recherche sémantique indisponible sur ce serveur (aucun fournisseur d\'embeddings configuré) : résultats par mots-clés (BM25).' : 'Recherche par mots-clés (BM25) : elle trouve les mots présents dans vos textes, pas leur sens.'}{!semantic && semAvail && ' La recherche sémantique est disponible : cochez la case ci-dessus.'}</p><Err error={s.error} />
        {hits && (hits.length === 0 ? <p className="muted">Aucun résultat.</p> : hits.map((h: any, i: number) => <div key={i} className="card flat" style={{ marginTop: 8 }}><b>{h.title}</b><p style={{ margin: '4px 0 0' }}>{h.text}</p></div>))}</form>
      <div className="card"><h3>Mes documents</h3><Err error={d.error} /><Table head={['Titre', 'Taille', 'Ajouté', '']} rows={list.map((x: any) => [x.title, `${x.chars} car.`, fmtDate(x.created_at),
        <div key="actions" className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => download(`/api/documents/${x.id}/export`, `${x.title.replace(/[^\w.\-]+/g, '_')}.txt`)}>Télécharger</button>
          <button className="btn sm danger" onClick={async () => { await api(`/api/documents/${x.id}`, { method: 'DELETE' }); d.reload(); }}>Supprimer</button>
        </div>])} empty="Aucun document." />
        {list.length < total && <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}><button type="button" className="btn sm" disabled={d.loading} onClick={() => setShown((n) => n + DOCS_PAGE)}>Charger plus ({list.length} / {total})</button></div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Agents */
export function Agents() {
  const g = useAsync(() => api('/api/agents')); const blank = { name: '', description: '', systemPrompt: '', useMemory: true, useDocuments: false };
  const [f, setF] = useState<any>(blank); const [editing, setEditing] = useState<string | null>(null); const a = useAction();
  const list = (g.data as any)?.agents ?? [];
  const save = (e: React.FormEvent) => { e.preventDefault(); a.run(async () => { await api(editing ? `/api/agents/${editing}` : '/api/agents', { method: editing ? 'PUT' : 'POST', body: f }); setF(blank); setEditing(null); g.reload(); }); };
  return (
    <div className="stack fadein"><h1 style={{ fontSize: '1.5rem' }}>Agents</h1><p className="muted">Un agent est un assistant avec ses propres consignes. Choisissez-le ensuite dans la conversation.</p>
      <form className="card" onSubmit={save}><h3>{editing ? 'Modifier l\'agent' : 'Nouvel agent'}</h3>
        <Field label="Nom"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
        <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} /></Field>
        <Field label="Consignes" hint="Décrivez son rôle, son ton et ses limites."><textarea value={f.systemPrompt} onChange={(e) => setF({ ...f, systemPrompt: e.target.value })} required minLength={5} /></Field>
        <div className="row"><label className="row"><input type="checkbox" checked={f.useMemory} onChange={(e) => setF({ ...f, useMemory: e.target.checked })} /> Utilise ma mémoire</label><label className="row"><input type="checkbox" checked={f.useDocuments} onChange={(e) => setF({ ...f, useDocuments: e.target.checked })} /> Utilise mes documents</label></div>
        <Err error={a.error} /><div className="row" style={{ marginTop: 10 }}><button className="btn primary" disabled={a.busy}>Enregistrer</button>{editing && <button type="button" className="btn" onClick={() => { setEditing(null); setF(blank); }}>Annuler</button>}</div></form>
      <div className="grid">{list.map((x: any) => <div className="card" key={x.id}><h3>{x.name}</h3><p className="muted">{x.description || '—'}</p>
        <div className="row"><button className="btn sm" onClick={() => { setEditing(x.id); setF({ name: x.name, description: x.description ?? '', systemPrompt: x.system_prompt, useMemory: !!x.use_memory, useDocuments: !!x.use_documents }); window.scrollTo(0, 0); }}>Modifier</button>
          <button className="btn sm danger" onClick={async () => { await api(`/api/agents/${x.id}`, { method: 'DELETE' }); g.reload(); }}>Supprimer</button></div></div>)}</div>
      {list.length === 0 && !g.loading && <p className="muted">Aucun agent pour l'instant.</p>}{g.loading && <Loading />}
    </div>
  );
}
export { Bars, go };
