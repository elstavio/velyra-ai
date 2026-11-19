import { useState, type CSSProperties } from 'react';
import { api, download, tokens } from './api';
import { Controls, Finance, SocialAdmin, TokensAdmin, UserSheet } from './admin2';
import { Alert, Bars, CountUp, Err, Field, Loading, StatusChip, Table, fmtDate, fmtMoney, go, rovingTabsKeyDown, useAction, useAsync } from './ui';
import { authenticatePasskey, registerPasskey, webauthnSupported } from './webauthn';

/* ------------------------------------------------------------------ Connexion en plusieurs étapes (§9) */
export function AdminLogin({ onAuth }: { onAuth: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [ch, setCh] = useState<{ id: string; steps: string[]; hasWebauthn?: boolean } | null>(null); const [setup, setSetup] = useState<any>(null); const [recovery, setRecovery] = useState<string[] | null>(null);
  const [code, setCode] = useState(''); const [useRecovery, setUseRecovery] = useState(false); const a = useAction(); const wa = useAction(); const [otpSent, setOtpSent] = useState(false);
  const finish = (r: any) => { if (r.done) { tokens.setAdmin(r.token); onAuth(); go('/admin'); } else setCh((c) => c && { ...c, steps: r.remaining }); setCode(''); };
  const next = ch?.steps[0];
  return (
    <div className="wrap" style={{ maxWidth: 460, paddingTop: 28 }}><div className="card stack">
      <h2>Administration</h2>
      {!ch && (<form onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api('/api/admin/auth/login', { body: { email, password } }); setCh({ id: r.challengeId, steps: r.steps, hasWebauthn: r.hasWebauthn }); setPassword(''); }); }}>
        <Field label="Email administrateur"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Mot de passe"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Err error={a.error} /><button className="btn primary" disabled={a.busy}>Continuer</button><p className="tiny">Chaque tentative de connexion expire après 20 minutes.</p></form>)}
      {ch && !recovery && next === 'totp' && ch.hasWebauthn && webauthnSupported() && (
        <div className="stack" style={{ marginBottom: 4 }}>
          <button type="button" className="btn primary" disabled={wa.busy} onClick={() => wa.run(async () => finish(await authenticatePasskey(ch.id)))}>Utiliser ma clé de sécurité</button>
          <Err error={wa.error} /><p className="tiny">Ou saisissez un code ci-dessous :</p>
        </div>)}
      {ch && recovery && (<div className="stack"><Alert kind="warn">Notez ces 10 codes de secours dans un endroit sûr. Ils ne seront plus jamais affichés. Chaque code ne sert qu'une fois, si vous perdez votre application d'authentification.</Alert>
        <pre aria-label="Codes de secours">{recovery.join('\n')}</pre>
        <button className="btn primary" onClick={() => a.run(async () => { const r = await api('/api/admin/auth/complete', { body: { challengeId: ch.id } }); setRecovery(null); finish(r); })}>J'ai enregistré mes codes</button><Err error={a.error} /></div>)}
      {ch && !recovery && next === 'totp_enroll' && (<div className="stack"><h3>Configurer la double authentification</h3>
        {!setup ? <><p className="muted">Votre compte doit être protégé par une application d'authentification (Google Authenticator, Aegis, 2FAS…).</p><button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => setSetup(await api('/api/admin/auth/totp/setup', { body: { challengeId: ch.id } })))}>Générer mon secret</button></>
          : <form onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api('/api/admin/auth/totp/confirm', { body: { challengeId: ch.id, code } }); setRecovery(r.recoveryCodes); setSetup(null); }); }}>
            <p>Dans votre application, ajoutez un compte par saisie manuelle avec ce secret :</p><pre aria-label="Secret TOTP" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{setup.secret}</pre><p className="tiny">Ou ouvrez ce lien sur le téléphone qui contient l'application : <a href={setup.otpauthUri}>ajouter à l'application</a>. Ne partagez ce secret avec personne.</p>
            <Field label="Code à 6 chiffres affiché par l'application"><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field><button className="btn primary" disabled={a.busy}>Activer</button></form>}
        <Err error={a.error} /></div>)}
      {ch && !recovery && next === 'totp' && (<form onSubmit={(e) => { e.preventDefault(); a.run(async () => finish(await api('/api/admin/auth/verify', { body: { challengeId: ch.id, step: useRecovery ? 'recovery' : 'totp', code } }))); }}>
        <Field label={useRecovery ? 'Code de secours' : 'Code de l\'application d\'authentification'}><input inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Err error={a.error} /><div className="row"><button className="btn primary" disabled={a.busy}>Valider</button><button type="button" className="btn sm" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>{useRecovery ? 'Utiliser l\'application' : 'Utiliser un code de secours'}</button></div></form>)}
      {ch && !recovery && next === 'email_otp' && (<div className="stack"><Alert>Nouvel appareil ou nouveau réseau : une confirmation par email est demandée.</Alert>
        {!otpSent ? <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await api('/api/admin/auth/email-otp', { body: { challengeId: ch.id } }); setOtpSent(true); })}>Envoyer le code par email</button>
          : <form onSubmit={(e) => { e.preventDefault(); a.run(async () => finish(await api('/api/admin/auth/verify', { body: { challengeId: ch.id, step: 'email_otp', code } }))); }}><Field label="Code reçu par email"><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field><button className="btn primary" disabled={a.busy}>Valider</button></form>}
        <Err error={a.error} /></div>)}
    </div></div>
  );
}

/* ------------------------------------------------------------------ Console */
const TABS: [string, string][] = [['', 'Vue d\'ensemble'], ['utilisateurs', 'Utilisateurs'], ['paiements', 'Paiements'], ['portefeuille', 'Portefeuille'], ['fraude', 'Fraude'], ['securite', 'Sécurité'], ['controles', 'Contrôles'], ['agents', 'Agents IA'],['finances', 'Finances'], ['jetons', 'Jetons'], ['reseaux', 'Réseaux'], ['ia', 'Analyses IA'], ['marketplace', 'Marketplace'], ['offres', 'Offres et prix'], ['systeme', 'Système']];
export function AdminConsole({ tab, onLogout }: { tab: string; onLogout: () => void }) {
  const me = useAsync(() => api('/api/admin/me', { admin: true }));
  return (
    <div className="wrap fadein" style={{ paddingTop: 18, paddingBottom: 60 }}>
      <div className="row between"><h1 className="h1-page">Administration</h1><div className="row"><span className="tiny">{(me.data as any)?.email}</span><button className="btn sm" onClick={async () => { await api('/api/admin/auth/logout', { method: 'POST', body: {}, admin: true }).catch(() => undefined); tokens.setAdmin(null); onLogout(); go('/admin/connexion'); }}>Déconnexion</button></div></div>
      <nav className="tabs" aria-label="Sections">{TABS.map(([k, l]) => <a key={k} href={`#/admin${k ? '/' + k : ''}`} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined}>{l}</a>)}</nav>
      {tab === '' && <Overview />}{tab === 'utilisateurs' && <Users />}{tab === 'paiements' && <Payments />}{tab === 'portefeuille' && <Wallet />}{tab === 'fraude' && <Fraud />}
      {tab === 'securite' && <Security />}{tab === 'controles' && <Controls />}{tab === 'finances' && <Finance />}{tab === 'jetons' && <TokensAdmin />}{tab === 'reseaux' && <SocialAdmin />}{tab === 'agents' && <Agents />}{tab === 'ia' && <Insights />}{tab === 'marketplace' && <Moderation />}{tab === 'offres' && <Plans />}{tab === 'systeme' && <System />}
    </div>
  );
}
const A = { admin: true };
const money = (m: Record<string, number>) => Object.entries(m).map(([c, n]) => fmtMoney(n, c)).join(' · ') || '0';

function Overview() {
  const d = useAsync(() => api('/api/admin/dashboard', A)); const x: any = d.data; const [cur, setCur] = useState('');
  if (d.error) return <Err error={d.error} />; if (!x) return <Loading />;
  const currencies = [...new Set<string>(x.revenue.daily.map((r: any) => r.currency))]; const c = cur || currencies[0] || '';
  const series = x.revenue.daily.filter((r: any) => r.currency === c).map((r: any) => ({ k: r.d, v: r.total }));
  const kpis: [string, number][] = [['Inscrits', x.users.total], ['Email confirmé', x.users.verified], ['Nouveaux (24 h)', x.users.newLast24h], ['Ont testé', x.users.tried], ['Payants', x.users.paying], ['Paiements en attente', x.pendingPayments], ['Signalements ouverts', x.fraudOpen], ['Tâches (24 h)', x.aiStats.tasksLast24h]];
  let i = 0; const stag = () => ({ '--d': i++ } as CSSProperties);
  return (
    <div className="stack">
      <div className="grid">{kpis.map(([k, v]) => <div className="card kpi stagger" style={stag()} key={k}><span className="tiny">{k}</span><b><CountUp value={v} /></b></div>)}</div>
      <div className="card stagger" style={stag()}><div className="row between"><h3>Revenus encaissés (90 jours)</h3>{currencies.length > 1 && <select aria-label="Devise" value={c} onChange={(e) => setCur(e.target.value)} style={{ width: 'auto' }}>{currencies.map((z) => <option key={z}>{z}</option>)}</select>}</div>
        <p className="muted">Aujourd'hui : {money(x.revenue.today)} · 7 jours : {money(x.revenue.last7days)} · 30 jours : {money(x.revenue.last30days)}</p>
        {series.length ? <Bars label={`Revenus quotidiens en ${c}`} data={series} format={(n) => fmtMoney(n, c)} /> : <p className="muted">Aucun paiement confirmé sur la période.</p>}
        <button className="btn sm" style={{ marginTop: 10 }} onClick={() => download('/api/admin/reports/revenue?format=csv&days=90', 'revenus.csv', true)}>Exporter en CSV</button></div>
      <div className="grid">
        <div className="card stagger" style={stag()}><h3>Soldes du portefeuille</h3>{x.wallets.length ? x.wallets.map((w: any) => <p key={w.currency} style={{ margin: 0 }}>{fmtMoney(w.balance, w.currency)}</p>) : <p className="muted">Vide.</p>}<p className="tiny">Virements en échec ou à vérifier : {x.payouts.problems} · retenus : {x.payouts.held}</p></div>
        <div className="card stagger" style={stag()}><h3>Utilisateurs par pays</h3>{x.users.byCountry.length ? x.users.byCountry.map((r: any) => <p key={r.country ?? '?'} style={{ margin: 0 }}>{r.country ?? 'non renseigné'} : {r.n}</p>) : <p className="muted">Aucun.</p>}</div>
        <div className="card stagger" style={stag()}><h3>Analyses IA</h3><p>{x.aiStats.pendingProposals} proposition(s) en attente. Dernière analyse : {fmtDate(x.aiStats.lastRun)}.</p><a href="#/admin/ia">Voir</a></div>
      </div>
      <div className="card stagger" style={stag()}><h3>Alertes de sécurité récentes</h3><Table head={['Date', 'Type', 'Gravité', 'IP']} rows={x.securityAlerts.map((e: any) => [fmtDate(e.created_at), e.type, <StatusChip key="s" s={e.severity} />, e.ip ?? '—'])} empty="Aucune alerte." /></div>
    </div>
  );
}

function Users() {
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const a = useAction(); const [sheet, setSheet] = useState<string | null>(null);
  const u = useAsync(() => api(`/api/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page}`, A), [q, status, page]); const x: any = u.data;
  const set = (id: string, st: string) => { const reason = st === 'active' ? 'réactivation' : prompt('Motif (obligatoire) :') ?? ''; if (!reason) return; a.run(async () => { await api(`/api/admin/users/${id}/status`, { body: { status: st, reason }, admin: true }); u.reload(); }); };
  return (<div className="stack"><div className="row"><input className="grow" placeholder="Rechercher un email" aria-label="Rechercher" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /><select aria-label="Statut" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 'auto' }}><option value="">Tous</option><option value="active">Actifs</option><option value="suspended">Suspendus</option><option value="revoked">Révoqués</option></select></div>
    <Err error={a.error || u.error} />
    {sheet && <UserSheet id={sheet} onClose={() => setSheet(null)} />}
    <div className="card"><Table head={['Email', 'Pays', 'Statut', 'Email', 'Tél.', 'Essais', 'Inscrit', 'Actions']} rows={(x?.users ?? []).map((r: any) => [r.email, r.country ?? '—', <StatusChip key="s" s={r.status} />, r.email_verified ? 'oui' : 'non', r.phone_verified ? 'oui' : 'non', r.trials_used, fmtDate(r.created_at),
      <div className="row" key="a"><button className="btn sm" onClick={() => setSheet(r.id)}>Fiche</button>{r.status === 'active' ? <><button className="btn sm" onClick={() => set(r.id, 'suspended')}>Suspendre</button><button className="btn sm danger" onClick={() => set(r.id, 'revoked')}>Révoquer</button></> : <button className="btn sm" onClick={() => set(r.id, 'active')}>Réactiver</button>}</div>])} /></div>
    {x && <div className="row between"><span className="tiny">{x.total} utilisateur(s)</span><div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button><button className="btn sm" disabled={page * x.pageSize >= x.total} onClick={() => setPage(page + 1)}>Suivant</button></div></div>}</div>);
}

function Payments() {
  const [status, setStatus] = useState(''); const [fl, setFl] = useState(false); const p = useAsync(() => api(`/api/admin/payments?status=${status}${fl ? '&flagged=1' : ''}`, A), [status, fl]);
  return (<div className="stack"><div className="row"><select aria-label="Statut" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Tous</option><option value="succeeded">Réussis</option><option value="pending">En attente</option><option value="failed">Échoués</option></select><label className="row"><input type="checkbox" checked={fl} onChange={(e) => setFl(e.target.checked)} /> Signalés fraude seulement</label></div><Err error={p.error} />
    <div className="card"><Table head={['Date', 'Réf.', 'Offre', 'Montant', 'Canal', 'Pays', 'État', 'Alerte']} rows={((p.data as any)?.payments ?? []).map((r: any) => [fmtDate(r.created_at), r.provider_ref, r.plan_code, fmtMoney(r.amount, r.currency), r.channel, r.country, <StatusChip key="s" s={r.status} />, r.fraud_flag ? <span key="f" className="chip bad">à vérifier</span> : ''])} /></div></div>);
}

function Wallet() {
  const w = useAsync(() => api('/api/admin/wallet', A)); const x: any = w.data; const a = useAction(); const [f, setF] = useState({ channel: 'wave', country: 'CI', phone: '' });
  if (w.error) return <Err error={w.error} />; if (!x) return <Loading />;
  return (<div className="stack">
    <div className="grid">{x.balances.map((b: any) => <div className="card kpi" key={b.currency}><span className="tiny">Solde {b.currency}</span><b>{fmtMoney(b.balance, b.currency)}</b></div>)}</div>
    <Alert>Les virements partent vers vos comptes Mobile Money enregistrés ci-dessous. Les numéros sont chiffrés au repos et n'apparaissent jamais en clair. Les virements suspects restent « retenus » jusqu'à votre validation.</Alert>
    <div className="card"><h3>Comptes de réception</h3><Err error={a.error} />
      <Table head={['Canal', 'Pays', 'Numéro', '', '']} rows={x.accounts.map((c: any) => [c.channel, c.country, c.masked, c.primary ? <span key="p" className="chip good">principal</span> : <button key="s" className="btn sm" onClick={() => a.run(async () => { await api(`/api/admin/payout-accounts/${c.id}/primary`, { method: 'POST', body: {}, admin: true }); w.reload(); })}>Définir principal</button>, <button key="d" className="btn sm danger" onClick={() => a.run(async () => { await api(`/api/admin/payout-accounts/${c.id}`, { method: 'DELETE', admin: true }); w.reload(); })}>Supprimer</button>])} empty="Aucun compte : les encaissements restent dans le portefeuille." />
      <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/admin/payout-accounts', { body: f, admin: true }); setF({ ...f, phone: '' }); w.reload(); }); }}>
        <select aria-label="Canal" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} style={{ width: 'auto' }}>{['wave', 'mtn', 'orange', 'moov'].map((c) => <option key={c}>{c}</option>)}</select>
        <input aria-label="Pays" value={f.country} maxLength={2} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} style={{ width: 70 }} /><input className="grow" aria-label="Numéro (sans indicatif)" placeholder="Numéro sans indicatif" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /><button className="btn primary" disabled={a.busy}>Ajouter</button></form></div>
    <div className="card"><div className="row between"><h3>Virements</h3><button className="btn sm" onClick={() => a.run(async () => { await api('/api/admin/payouts/run', { method: 'POST', body: {}, admin: true }); w.reload(); })}>Traiter maintenant</button></div>
      <Table head={['Date', 'Montant', 'Canal', 'État', 'Essais', 'Erreur', '']} rows={x.payouts.map((p: any) => [fmtDate(p.created_at), fmtMoney(p.amount, p.currency), p.channel ?? '—', <StatusChip key="s" s={p.status} />, p.attempts, p.last_error ?? '', p.status === 'held' ? <button key="r" className="btn sm" onClick={() => a.run(async () => { await api(`/api/admin/payouts/${p.id}/release`, { method: 'POST', body: {}, admin: true }); w.reload(); })}>Valider</button> : ''])} /></div>
    <div className="card"><h3>Journal du portefeuille</h3><Table head={['Date', 'Type', 'Montant', 'Solde après', 'Note']} rows={x.ledger.map((l: any) => [fmtDate(l.created_at), l.kind, fmtMoney(l.amount, l.currency), fmtMoney(l.balance_after, l.currency), l.note ?? ''])} /></div></div>);
}

function Fraud() {
  const [st, setSt] = useState('open'); const f = useAsync(() => api(`/api/admin/fraud?status=${st}`, A), [st]); const a = useAction();
  const rev = (id: string, decision: string, suspend: boolean) => { const note = prompt('Note de décision (facultatif) :') ?? ''; a.run(async () => { await api(`/api/admin/fraud/${id}/review`, { body: { decision, suspend, note }, admin: true }); f.reload(); }); };
  return (<div className="stack"><Alert>Aucun compte n'est suspendu automatiquement : un humain décide. Les signalements viennent de règles simples (inscriptions groupées, paiements suspects).</Alert>
    <select aria-label="Statut" value={st} onChange={(e) => setSt(e.target.value)} style={{ width: 'auto' }}><option value="open">Ouverts</option><option value="confirmed">Confirmés</option><option value="dismissed">Écartés</option></select><Err error={a.error || f.error} />
    <div className="card"><Table head={['Date', 'Utilisateur', 'Motif', 'Décision', '']} rows={((f.data as any)?.reports ?? []).map((r: any) => [fmtDate(r.created_at), r.user_email ?? '—', r.reason, r.resolution ?? '', r.status === 'open' ? <div className="row" key="a"><button className="btn sm" onClick={() => rev(r.id, 'dismiss', false)}>Écarter</button><button className="btn sm danger" onClick={() => rev(r.id, 'confirm', true)}>Confirmer et suspendre</button></div> : ''])} empty="Aucun signalement." /></div></div>);
}

function Security() {
  const ev = useAsync(() => api('/api/admin/security/events', A)); const bl = useAsync(() => api('/api/admin/security/blocks', A)); const ses = useAsync(() => api('/api/admin/sessions', A)); const lg = useAsync(() => api('/api/admin/logins', A));
  const ov = useAsync(() => api('/api/admin/security/overview', A));
  const [chain, setChain] = useState<any>(null); const [ip, setIp] = useState(''); const a = useAction(); const [view, setView] = useState('events');
  const o: any = ov.data ?? {};
  return (<div className="stack">
    <div className="card row"><button className="btn" onClick={() => a.run(async () => setChain(await api('/api/admin/security/verify-chain', A)))}>Vérifier l'intégrité du journal</button><button className="btn" onClick={() => download('/api/admin/security/evidence', 'preuves-securite.json', true)}>Exporter les preuves (JSON)</button>
      {chain && <Alert kind={chain.ok ? 'ok' : 'err'}>{chain.ok ? `Journal intact (${chain.checked ?? ''} événements chaînés).` : `Anomalie détectée : ${JSON.stringify(chain).slice(0, 200)}`}</Alert>}<Err error={a.error} /></div>
    {(o.pendingPayouts ?? []).length > 0 && <Alert kind="warn">{o.pendingPayouts.length} retrait(s) en attente de votre confirmation par email — aucun fonds ne sortira tant que vous n'aurez pas cliqué le lien reçu.</Alert>}
    <div className="tabs" role="tablist" aria-label="Sections de sécurité">{[['events', 'Événements'], ['intrusion', 'Piège & intrusions'], ['retraits', 'Retraits à confirmer'], ['passkeys', 'Clés de sécurité'], ['blocks', 'IP bloquées'], ['sessions', 'Sessions'], ['logins', 'Connexions']].map(([k, l]) => <a key={k} id={`security-tab-${k}`} href="#/admin/securite" role="tab" aria-selected={view === k} aria-controls="security-panel" tabIndex={view === k ? 0 : -1} className={view === k ? 'on' : ''} onClick={(e) => { e.preventDefault(); setView(k); }} onKeyDown={rovingTabsKeyDown}>{l}</a>)}</div>
    <div role="tabpanel" id="security-panel" aria-labelledby={`security-tab-${view}`} tabIndex={0}>
    {view === 'events' && <div className="card"><Table head={['Date', 'Type', 'Gravité', 'IP']} rows={((ev.data as any)?.events ?? []).map((e: any) => [fmtDate(e.created_at), e.type, <StatusChip key="s" s={e.severity} />, e.ip ?? '—'])} /></div>}
    {view === 'intrusion' && <div className="stack">
      <Alert>Routes-pièges invisibles dans la vraie application : toute requête dessus déclenche un blocage immédiat de l'IP et une alerte critique. Les informations captées sont purgées automatiquement après {o.retentionDays ?? 10} jours (la preuve d'incident, elle, reste dans le journal chaîné ci-dessus).</Alert>
      <div className="card row"><b>{o.honeypotTotal ?? 0}</b> capture(s) au total <button className="btn sm" onClick={() => a.run(async () => { await api('/api/admin/security/honeypot/purge', { method: 'POST', body: {}, admin: true }); ov.reload(); }, 'Purge effectuée.')}>Purger maintenant</button>{a.ok && <Alert kind="ok">{a.ok}</Alert>}</div>
      <div className="card"><h3>Intrusions piégées (30 derniers jours)</h3><Table head={['Date', 'IP', 'Route visée', 'Méthode', 'Appareil']} rows={(o.honeypot ?? []).map((h: any) => [fmtDate(h.created_at), h.ip, h.path, h.method, h.user_agent ?? '—'])} empty="Aucune intrusion piégée pour l'instant." /></div>
      <div className="card"><h3>Événements critiques récents</h3><Table head={['Date', 'Type', 'IP', 'Détail']} rows={(o.criticalEvents ?? []).map((e: any) => [fmtDate(e.created_at), e.type, e.ip ?? '—', (e.detail ?? '').slice(0, 120)])} empty="Aucun." /></div>
      <div className="card"><h3>Nouvel appareil / IP détecté chez un utilisateur</h3><Table head={['Date', 'IP']} rows={(o.newDevices ?? []).map((d: any) => [fmtDate(d.created_at), d.ip ?? '—'])} empty="Aucun." /><p className="tiny">L'utilisateur reçoit automatiquement un email de vigilance ; une IP seule ne permet pas de détecter de façon fiable un VPN sans service tiers payant (non configuré par défaut).</p></div>
    </div>}
    {view === 'retraits' && <div className="card"><Alert>Chaque retrait — automatique ou lancé depuis l'admin — exige qu'un lien envoyé par email à votre adresse soit cliqué avant toute exécution réelle.</Alert>
      <Table head={['Transfert', 'Montant', 'Demandé le', 'Expire le', 'Envois']} rows={(o.pendingPayouts ?? []).map((p: any) => [p.payout_id, `${p.amount} ${p.currency}`, fmtDate(p.created_at), fmtDate(p.expires_at), p.sent_count])} empty="Aucun retrait en attente de confirmation." /></div>}
    {view === 'passkeys' && <Passkeys />}
    {view === 'blocks' && <div className="card"><form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/admin/security/blocks', { body: { ip, reason: 'blocage manuel' }, admin: true }); setIp(''); bl.reload(); }); }}><input className="grow" aria-label="Adresse IP" placeholder="Adresse IP à bloquer" value={ip} onChange={(e) => setIp(e.target.value)} required /><button className="btn primary">Bloquer</button></form>
      <Table head={['IP', 'Motif', 'Depuis', 'Expire', '']} rows={((bl.data as any)?.blocks ?? []).map((b: any) => [b.ip, b.reason, fmtDate(b.created_at), b.permanent ? 'jamais' : fmtDate(b.expires_at), <button key="u" className="btn sm" onClick={() => a.run(async () => { await api('/api/admin/security/blocks/remove', { body: { ip: b.ip }, admin: true }); bl.reload(); })}>Débloquer</button>])} empty="Aucune IP bloquée." /></div>}
    {view === 'sessions' && <div className="card"><Table head={['Email', 'IP', 'Type', 'Dernière activité', '']} rows={((ses.data as any)?.sessions ?? []).map((s: any) => [s.email, s.ip, s.is_admin ? 'admin' : 'utilisateur', fmtDate(s.last_seen_at), <button key="r" className="btn sm danger" onClick={() => a.run(async () => { await api(`/api/admin/sessions/${s.id}/revoke`, { method: 'POST', body: {}, admin: true }); ses.reload(); })}>Révoquer</button>])} /></div>}
    {view === 'logins' && <div className="card"><Table head={['Date', 'Email', 'IP', 'Résultat', 'Détail']} rows={((lg.data as any)?.logins ?? []).map((l: any) => [fmtDate(l.created_at), l.email ?? '—', l.ip, l.success ? 'réussie' : 'échec', l.reason ?? ''])} /></div>}
    </div>
  </div>);
}

function Passkeys() {
  const l = useAsync(() => api('/api/admin/webauthn/credentials', A)); const a = useAction(); const [name, setName] = useState('');
  return (<div className="stack">
    <Alert>Une clé de sécurité (Face ID, Touch ID, Windows Hello, YubiKey…) remplace la saisie d'un code de l'application d'authentification lors de la connexion. Elle ne remplace pas le mot de passe.</Alert>
    {!webauthnSupported() && <Alert kind="warn">Ce navigateur ne prend pas en charge les clés de sécurité (WebAuthn).</Alert>}
    {webauthnSupported() && <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await registerPasskey(name || 'Clé de sécurité'); setName(''); l.reload(); }, 'Clé enregistrée.'); }}>
      <input className="grow" aria-label="Nom de la clé" placeholder="Nom de la clé (ex. YubiKey bureau)" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn primary" disabled={a.busy}>Enregistrer une nouvelle clé</button></form>}
    <Err error={a.error} />{a.ok && <Alert kind="ok">{a.ok}</Alert>}
    <div className="card"><Table head={['Nom', 'Ajoutée le', 'Dernière utilisation', '']} rows={((l.data as any)?.credentials ?? []).map((c: any) => [c.name ?? '—', fmtDate(c.created_at), c.last_used_at ? fmtDate(c.last_used_at) : 'jamais', <button key="d" className="btn sm danger" onClick={() => a.run(async () => { await api(`/api/admin/webauthn/credentials/${c.id}`, { method: 'DELETE', admin: true }); l.reload(); })}>Supprimer</button>])} empty="Aucune clé de sécurité enregistrée." /></div>
  </div>);
}

function Insights() {
  const d = useAsync(() => api('/api/admin/ai', A)); const a = useAction(); const x: any = d.data;
  return (<div className="stack"><Alert>{x?.notice ?? 'Analyse statistique des données agrégées et anonymes.'} Il s'agit de règles statistiques, pas d'un modèle d'apprentissage.</Alert>
    <div className="row"><button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await api('/api/admin/ai/run', { method: 'POST', body: {}, admin: true }); d.reload(); })}>{a.busy ? 'Analyse…' : 'Lancer une analyse'}</button></div><Err error={a.error || d.error} />
    {(x?.proposals ?? []).length === 0 && !d.loading && <p className="muted">Aucune proposition.</p>}
    {(x?.proposals ?? []).map((p: any) => <div className="card" key={p.id}><div className="row between"><h3 style={{ margin: 0 }}>{p.title}</h3><StatusChip s={p.status} /></div><p>{p.detail}</p>{p.evidence && <pre>{JSON.stringify(p.evidence, null, 2)}</pre>}<p className="tiny">{fmtDate(p.created_at)}</p>
      {p.status === 'pending' && <div className="row"><button className="btn sm primary" onClick={() => a.run(async () => { await api(`/api/admin/ai/${p.id}/decision`, { body: { decision: 'approved' }, admin: true }); d.reload(); })}>Approuver</button><button className="btn sm" onClick={() => a.run(async () => { await api(`/api/admin/ai/${p.id}/decision`, { body: { decision: 'rejected' }, admin: true }); d.reload(); })}>Rejeter</button></div>}</div>)}
    <p className="tiny">Approuver acte votre décision ; rien n'est appliqué automatiquement.</p></div>);
}

function Moderation() {
  const l = useAsync(() => api('/api/admin/marketplace?status=pending', A)); const a = useAction();
  return (<div className="stack"><Err error={a.error || l.error} />{((l.data as any)?.listings ?? []).length === 0 && !l.loading && <p className="muted">Aucune annonce à relire.</p>}
    {((l.data as any)?.listings ?? []).map((x: any) => <div className="card" key={x.id}><div className="row between"><h3 style={{ margin: 0 }}>{x.title}</h3><span className="chip">{x.kind}</span></div><p>{x.description}</p><p className="tiny">Par {x.owner}</p><pre>{JSON.stringify(x.payload, null, 2)}</pre>
      <div className="row"><button className="btn sm primary" onClick={() => a.run(async () => { await api(`/api/admin/marketplace/${x.id}/moderate`, { body: { decision: 'approved' }, admin: true }); l.reload(); })}>Approuver</button><button className="btn sm danger" onClick={() => a.run(async () => { await api(`/api/admin/marketplace/${x.id}/moderate`, { body: { decision: 'rejected' }, admin: true }); l.reload(); })}>Refuser</button></div></div>)}</div>);
}

function Plans() {
  const p = useAsync(() => api('/api/admin/plans', A)); const a = useAction(); const [edit, setEdit] = useState<Record<string, string>>({});
  return (<div className="stack"><Alert kind="warn">Les prix par défaut sont des exemples. Fixez les vôtres : en dehors du dollar, le montant doit être un multiple de 5 (exigence de l'agrégateur CinetPay).</Alert><Err error={a.error || p.error} />
    {((p.data as any)?.plans ?? []).map((pl: any) => <div className="card" key={pl.code}><h3>{pl.name} <span className="tiny">({pl.code})</span></h3>
      <div className="grid">{pl.prices.map((pr: any) => { const k = `${pl.code}:${pr.currency}`; return <form key={k} className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/api/admin/plans/${pl.code}/price`, { method: 'PUT', body: { currency: pr.currency, amount: Number(edit[k] ?? pr.amount) }, admin: true }); p.reload(); }, 'Prix enregistré.'); }}>
        <label className="row grow"><b style={{ width: 40 }}>{pr.currency}</b><input type="number" min={1} aria-label={`Prix en ${pr.currency}`} value={edit[k] ?? pr.amount} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></label><button className="btn sm">Enregistrer</button></form>; })}</div></div>)}
    {a.ok && <Alert kind="ok">{a.ok}</Alert>}</div>);
}

function Secrets() {
  const sv = useAsync(() => api('/api/admin/security/secrets', A)); const a = useAction(); const x: any = sv.data;
  if (sv.error) return <Err error={sv.error} />; if (!x) return <Loading />;
  return (<div className="card"><h3>Coffre-fort de secrets</h3>
    <p className="tiny">Statut uniquement : les clés et jetons eux-mêmes vivent dans les variables d'environnement de l'hébergeur, jamais dans l'application ni cette page. Déclarez une rotation après avoir changé une clé chez le fournisseur.</p>
    {x.missingCritical.length > 0 && <Alert kind="warn">Secret(s) critique(s) manquant(s) : {x.missingCritical.join(', ')}</Alert>}
    <Err error={a.error} />{a.ok && <Alert kind="ok">{a.ok}</Alert>}
    <Table head={['Secret', 'Rôle', 'Statut', 'Dernière rotation déclarée', '']} rows={x.items.map((i: any) => [i.key, i.label, i.present ? <StatusChip key="c" s="ok" /> : (i.critical ? <StatusChip key="c" s="critical" /> : 'non configuré'), i.rotatedAt ? fmtDate(i.rotatedAt) : '—', <button key="r" className="btn sm" disabled={!i.present} onClick={() => a.run(async () => { await api(`/api/admin/security/secrets/${i.key}/rotated`, { method: 'POST', body: {}, admin: true }); sv.reload(); }, 'Rotation déclarée.')}>J'ai tourné cette clé</button>])} /></div>);
}

function System() {
  const s = useAsync(() => api('/api/admin/system', A)); const a = useAction(); const x: any = s.data; const au = useAsync(() => api('/api/admin/audit', A));
  if (s.error) return <Err error={s.error} />; if (!x) return <Loading />;
  return (<div className="stack">
    <div className="grid"><div className="card kpi"><span className="tiny">Santé</span><b>{x.health.ok ? 'Bonne' : 'Dégradée'}</b></div><div className="card kpi"><span className="tiny">Disponibilité</span><b>{Math.round(x.uptimeSec / 60)} min</b></div>
      <div className="card"><span className="tiny">Passerelles</span><p style={{ margin: 0 }}>Paiement : {x.payment.provider}<br />Virements : {x.payment.payout}<br />IA : {x.aiProviders.join(', ') || 'aucune clé configurée'}</p></div>
      <div className="card"><span className="tiny">Budget IA (aujourd'hui)</span>{x.aiBudget.budget ? <><b>{x.aiBudget.tokens.toLocaleString('fr-FR')} / {x.aiBudget.budget.toLocaleString('fr-FR')} jetons</b><p className="tiny" style={{ margin: '4px 0 0' }}>{x.aiBudget.costUsd > 0 ? `≈ ${x.aiBudget.costUsd.toFixed(2)} $ au tarif renseigné (AI_COST_*_PER_MTOK)` : 'Coût en $ non estimé (tarifs non renseignés)'}</p></> : <p className="tiny" style={{ margin: 0 }}>Coupe-circuit désactivé (AI_DAILY_TOKEN_BUDGET=0)</p>}</div></div>
    {x.payment.provider === 'mock' && <Alert kind="warn">Mode démonstration : les paiements sont simulés. Configurez CinetPay avant la mise en production.</Alert>}
    <Secrets />
    <div className="card row"><button className="btn" disabled={a.busy} onClick={() => a.run(async () => { await api('/api/admin/system/backup', { method: 'POST', body: {}, admin: true }); s.reload(); }, 'Sauvegarde créée.')}>Créer une sauvegarde</button><button className="btn" disabled={a.busy} onClick={() => a.run(async () => { const r = await api('/api/admin/system/heal', { method: 'POST', body: {}, admin: true }); return r; }, 'Nettoyage effectué.')}>Lancer l'auto-réparation</button><Err error={a.error} />{a.ok && <Alert kind="ok">{a.ok}</Alert>}</div>
    <div className="card"><h3>Sauvegardes</h3><Table head={['Nom', 'Taille', 'Date', '']} rows={(x.backups ?? []).map((b: any) => [b.name ?? b.id, b.bytes ? `${Math.round(b.bytes / 1024)} Ko` : '', fmtDate(b.created_at), b.name ? <button key="d" className="btn sm" onClick={() => download(`/api/admin/system/backups/${encodeURIComponent(b.name)}`, b.name, true)}>Télécharger</button> : ''])} empty="Aucune sauvegarde." /><p className="tiny">Les sauvegardes sont logiques (JSON compressé). Sur un hébergement gratuit, le disque est éphémère : téléchargez-les régulièrement.</p></div>
    <div className="card"><h3>Erreurs récentes</h3><Table head={['Date', 'Route', 'Message']} rows={(x.errors ?? []).map((e: any) => [fmtDate(e.created_at), e.route, e.message])} empty="Aucune erreur enregistrée." /></div>
    <div className="card"><h3>Journal d'audit</h3><Table head={['Date', 'Action', 'Cible']} rows={((au.data as any)?.audit ?? []).map((e: any) => [fmtDate(e.created_at), e.action, e.target ?? ''])} /></div></div>);
}

/* ------------------------------------------------------------------ Agents IA (5 agents + superviseur) */
function Agents() {
  const o = useAsync(() => api('/api/admin/agents', A)); const a = useAction(); const [open, setOpen] = useState<string | null>(null);
  const d: any = o.data;
  const run = (path: string) => a.run(async () => { await api(path, { method: 'POST', body: {}, ...A }); o.reload(); });
  if (o.loading) return <Loading />; if (o.error || !d) return <Err error={o.error ?? 'Indisponible'} />;
  const dot = (s: string) => (s === 'ok' ? 'good' : s === 'failed' ? 'bad' : 'warn');
  return (<div className="stack">
    <div className="card"><div className="row between"><div><h3 style={{ margin: 0 }}>6 agents IA intégrés</h3><p className="tiny" style={{ margin: 0 }}>{d.config.schedule}. Fournisseur : {d.config.llmConfigured ? `${d.config.aiProvider} (${d.config.model})` : 'aucun configuré — synthèses par règles'}. Planificateur externe : {d.config.cronConfigured ? 'configuré' : 'non configuré (CRON_SECRET)'}.</p></div>
      <button className="btn primary" disabled={a.busy} onClick={() => run('/api/admin/agents/run')}>{a.busy ? 'Exécution…' : 'Tout lancer'}</button></div>
      {!d.config.llmConfigured && <Alert kind="warn">Aucune clé d'IA détectée (OPENAI_API_KEY) : les agents tournent quand même, avec des synthèses calculées par règles.</Alert>}
      <p className="tiny">{d.notice}</p><Err error={a.error} /></div>
    {d.agents.map((g: any) => (
      <div className="card" key={g.name}>
        <div className="row between"><div><h3 style={{ margin: 0 }}>{g.label}</h3><p className="tiny" style={{ margin: 0 }}>{g.job}</p></div>
          <div className="row"><span className={`chip ${g.doneToday ? 'good' : 'warn'}`}>{g.doneToday ? "fait aujourd'hui" : "pas encore aujourd'hui"}</span>
            {g.name !== 'superviseur' && <button className="btn sm" disabled={a.busy} onClick={() => run(`/api/admin/agents/${g.name}/run`)}>Lancer</button>}</div></div>
        <div className="row" style={{ marginTop: 8 }} aria-label="7 derniers jours">{g.history.map((h: any) => <span key={h.day} className={`chip ${dot(h.state === 'missing' ? 'x' : h.state)}`} title={`${h.day} : ${h.state === 'ok' ? 'réussi' : h.state === 'failed' ? 'échec' : 'absent'}`}>{h.day.slice(8)}{h.state === 'ok' ? ' ✓' : h.state === 'failed' ? ' ✗' : ' –'}</span>)}</div>
        {g.last ? (<div style={{ marginTop: 8 }}>
          <p className="tiny">Dernière exécution : {fmtDate(g.last.started_at)} · {g.last.status === 'ok' ? 'réussie' : g.last.status} · {g.last.provider ? (g.last.provider === 'rules' ? 'règles (sans IA)' : `${g.last.provider} ${g.last.model ?? ''}`) : ''}{g.last.error ? ` · ${g.last.error}` : ''}</p>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{open === g.name ? g.last.summary : String(g.last.summary ?? '').slice(0, 420)}</pre>
          {String(g.last.summary ?? '').length > 420 && <button className="btn sm" onClick={() => setOpen(open === g.name ? null : g.name)}>{open === g.name ? 'Réduire' : 'Tout lire'}</button>}
        </div>) : <p className="muted">Pas encore exécuté.</p>}
      </div>))}
  </div>);
}
