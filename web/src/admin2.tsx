import { useState } from 'react';
import { api, download } from './api';
import { Alert, CountUp, Err, Field, Loading, StatusChip, Table, fmtDate, fmtMoney, fmtNum, useAction, useAsync } from './ui';

const A = { admin: true };
const SEV: Record<string, string> = { critical: 'bad', high: 'bad', medium: 'warn', low: 'good' };

/* ------------------------------------------------------------------ Contrôles d'intégrité */
export function Controls() {
  const o = useAsync(() => api('/api/admin/integrity', A)); const a = useAction(); const d: any = o.data;
  if (o.loading && !d) return <Loading />; if (!d) return <Err error={o.error ?? 'Indisponible'} />;
  return (<div className="stack">
    <div className="card"><div className="row between"><div><h3 style={{ margin: 0 }}>Contrôles automatiques</h3><p className="tiny" style={{ margin: 0 }}>{d.checks.length} contrôles SQL rejoués toutes les 30 minutes et après chaque mise à jour quotidienne. Les corrections sûres sont appliquées immédiatement ; les autres vous alertent aussitôt (SMS si critique).</p></div>
      <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await api('/api/admin/integrity/run', { method: 'POST', body: {}, ...A }); o.reload(); })}>{a.busy ? 'Contrôle…' : 'Tout contrôler maintenant'}</button></div><Err error={a.error} />
      {d.open.length === 0 ? <Alert kind="ok">Aucune anomalie ouverte.</Alert> : <Alert kind="err">{d.open.length} anomalie(s) ouverte(s) à traiter.</Alert>}</div>
    <div className="card"><Table head={['Contrôle', 'Gravité', 'Correction auto', 'État']} rows={d.checks.map((c: any) => [c.label, <span key="s" className={`chip ${SEV[c.severity]}`}>{c.severity}</span>, c.autoFix ? 'oui (sûre)' : 'non : décision humaine', c.open ? <span key="o" className="chip bad" title={c.open.detail}>anomalie : {c.open.detail}</span> : <span key="o" className="chip good">OK</span>])} /></div>
    <div className="card"><h3>Corrigées automatiquement (récent)</h3><Table head={['Date', 'Contrôle', 'Anomalie', 'Correction']} rows={d.recentlyFixed.map((f: any) => [fmtDate(f.resolved_at), f.check_id, f.detail, f.fix_note])} empty="Aucune correction automatique récente." /></div>
  </div>);
}

/* ------------------------------------------------------------------ Jetons */
export function TokensAdmin() {
  const o = useAsync(() => api('/api/admin/tokens', A)); const a = useAction(); const [f, setF] = useState({ email: '', delta: '', reason: '' }); const d: any = o.data;
  if (o.loading && !d) return <Loading />; if (!d) return <Err error={o.error ?? 'Indisponible'} />;
  return (<div className="stack">
    <div className="grid">{[['Vendus', d.sold], ['Offerts', d.granted], ['Consommés', d.used], ['Restitués', d.refunded], ['En circulation', d.outstanding], ['Détenteurs', d.holders]].map(([k, v]) => <div className="card" key={k as string}><div className="bignum sm"><CountUp value={v as number} /></div><p className="muted" style={{ margin: 0 }}>{k}</p></div>)}</div>
    <p className="tiny">{d.note} Les prix des paquets se règlent dans « Offres et prix » (CDF, GNF et USD sont à définir par vous).</p>
    <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/admin/tokens/adjust', { body: { email: f.email, delta: Number(f.delta), reason: f.reason }, ...A }); setF({ email: '', delta: '', reason: '' }); o.reload(); }); }}>
      <h3>Ajouter ou retirer des jetons</h3><div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Field label="Email de l'utilisateur"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Quantité (négative pour retirer)"><input type="number" required value={f.delta} onChange={(e) => setF({ ...f, delta: e.target.value })} /></Field>
        <Field label="Motif (obligatoire, journalisé)"><input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
      <Err error={a.error} /><button className="btn primary" disabled={a.busy}>Appliquer</button></form>
    <div className="card"><h3>Paquets vendus</h3><Table head={['Paquet', 'Ventes', 'Encaissé']} rows={d.packs.map((p: any) => [p.plan_code, p.n, fmtMoney(p.revenue, p.currency)])} empty="Aucune vente." /></div>
    <div className="card"><h3>Soldes bas (1 à 10 jetons)</h3><Table head={['Email', 'Solde']} rows={d.low.map((r: any) => [r.email, r.balance])} empty="Aucun." /></div>
    <div className="card"><h3>Plus gros soldes</h3><Table head={['Email', 'Solde']} rows={d.top.map((r: any) => [r.email, fmtNum(r.balance)])} empty="Aucun." /></div>
    <div className="card"><h3>Mouvements récents (hors consommation)</h3><Table head={['Date', 'Email', 'Quantité', 'Type', 'Note']} rows={d.recent.map((r: any) => [fmtDate(r.created_at), r.email, r.delta, r.reason, r.note ?? ''])} /></div>
    <button className="btn" onClick={() => download('/api/admin/export/tokens', 'jetons.csv', true)}>Exporter le journal (CSV)</button>
  </div>);
}

/* ------------------------------------------------------------------ Réseaux et publications */
export function SocialAdmin() {
  const o = useAsync(() => api('/api/admin/social', A)); const a = useAction(); const d: any = o.data;
  if (o.loading && !d) return <Loading />; if (!d) return <Err error={o.error ?? 'Indisponible'} />;
  return (<div className="stack">
    <div className="card"><div className="row between"><div><h3 style={{ margin: 0 }}>Coupe-circuit de publication</h3><p className="tiny" style={{ margin: 0 }}>{d.killed ? 'La publication est SUSPENDUE pour tous les utilisateurs.' : 'La publication est active (toujours après double validation de l\'utilisateur).'}</p></div>
      <button className={`btn ${d.killed ? 'primary' : 'danger'}`} disabled={a.busy} onClick={() => { if (d.killed || confirm('Suspendre immédiatement toutes les publications ?')) a.run(async () => { await api('/api/admin/social/kill', { body: { on: !d.killed }, ...A }); o.reload(); }); }}>{d.killed ? 'Reprendre les publications' : 'Suspendre toutes les publications'}</button></div><Err error={a.error} /></div>
    {d.publishedWithoutApproval > 0 ? <Alert kind="err">{d.publishedWithoutApproval} publication(s) sans validation journalisée correspondante : à examiner immédiatement.</Alert> : <Alert kind="ok">Vérifié : chaque publication a sa double validation enregistrée pour le contenu exact publié.</Alert>}
    <div className="card"><h3>Comptes connectés</h3><Table head={['Plateforme', 'État', 'Nombre']} rows={d.accounts.map((r: any) => [r.platform, <StatusChip key="s" s={r.status} />, r.n])} empty="Aucun compte connecté." /></div>
    <div className="card"><h3>Publications</h3><p className="tiny">{d.byStatus.map((s: any) => `${s.status} : ${s.n}`).join(' · ') || 'Aucune.'}</p>
      <Table head={['Date', 'Utilisateur', 'Plateforme', 'État', 'Auteur', 'Validations', 'Extrait', 'Erreur']} rows={d.posts.map((p: any) => [fmtDate(p.created_at), p.email, p.platform, <StatusChip key="s" s={p.status} />, p.created_by === 'agent' ? 'agent' : 'utilisateur', p.approvals, p.excerpt, p.error ?? ''])} empty="Aucune publication." />
      <button className="btn" style={{ marginTop: 8 }} onClick={() => download('/api/admin/export/posts', 'publications.csv', true)}>Exporter (CSV)</button></div>
  </div>);
}

/* ------------------------------------------------------------------ Finances */
export function Finance() {
  const [days, setDays] = useState(30); const o = useAsync(() => api(`/api/admin/finance?days=${days}`, A), [days]); const d: any = o.data;
  if (o.loading && !d) return <Loading />; if (!d) return <Err error={o.error ?? 'Indisponible'} />;
  const sum = (rows: any[]) => Object.entries(rows.reduce((m: any, r: any) => ((m[r.currency] = (m[r.currency] ?? 0) + Number(r.total)), m), {})).map(([c, v]) => fmtMoney(v as number, c)).join(' · ') || '—';
  return (<div className="stack">
    <div className="row"><select aria-label="Période" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>{[7, 30, 90, 365].map((n) => <option key={n} value={n}>{n} derniers jours</option>)}</select>
      <button className="btn" onClick={() => download('/api/admin/export/payments', 'paiements.csv', true)}>Exporter les paiements (CSV)</button><button className="btn" onClick={() => download('/api/admin/export/users', 'utilisateurs.csv', true)}>Exporter les utilisateurs (CSV)</button></div>
    <div className="grid"><div className="card"><div className="bignum sm">{sum(d.byPlan)}</div><p className="muted" style={{ margin: 0 }}>encaissé sur la période</p></div> {/* I2 : non animé — agrège plusieurs devises en une chaîne jointe par " · ", pas un chiffre unique animable sans changer l'affichage */}
      <div className="card"><div className="bignum sm"><CountUp value={d.activeSubscribers} /></div><p className="muted" style={{ margin: 0 }}>abonnés actifs maintenant</p></div>
      <div className="card"><div className="bignum sm"><CountUp value={d.flagged} /></div><p className="muted" style={{ margin: 0 }}>paiement(s) signalé(s)</p></div></div>
    <div className="card"><h3>Par offre</h3><Table head={['Offre', 'Ventes', 'Total']} rows={d.byPlan.map((r: any) => [r.plan_code, r.n, fmtMoney(r.total, r.currency)])} empty="Aucun encaissement." /></div>
    <div className="card"><h3>Par moyen de paiement</h3><Table head={['Moyen', 'Ventes', 'Total']} rows={d.byChannel.map((r: any) => [r.channel, r.n, fmtMoney(r.total, r.currency)])} empty="Aucun encaissement." /></div>
    <div className="card"><h3>État des paiements créés</h3><Table head={['État', 'Nombre']} rows={d.status.map((r: any) => [<StatusChip key="s" s={r.status} />, r.n])} /></div>
    <div className="card"><h3>Par jour</h3><Table head={['Jour', 'Ventes', 'Total']} rows={d.byDay.map((r: any) => [r.day, r.n, fmtMoney(r.total, r.currency)])} empty="Aucun encaissement." /></div>
  </div>);
}

/* ------------------------------------------------------------------ Fiche utilisateur 360° */
export function UserSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const o = useAsync(() => api(`/api/admin/users/${id}/overview`, A), [id]); const d: any = o.data;
  return (<div className="card" style={{ borderColor: 'var(--gold-bright)' }}>
    <div className="row between"><h3 style={{ margin: 0 }}>Fiche utilisateur</h3><button className="btn sm" onClick={onClose}>Fermer</button></div>
    {o.loading ? <Loading /> : !d ? <Err error={o.error} /> : (<div className="stack">
      <p style={{ margin: 0 }}><b>{d.user.email}</b> · {d.user.country ?? '—'} · <StatusChip s={d.user.status} /> · email {d.user.email_verified ? 'confirmé' : 'non confirmé'} · téléphone {d.user.phone_verified ? 'confirmé' : 'non confirmé'} · essais utilisés {d.user.trials_used} · inscrit {fmtDate(d.user.created_at)} · {d.tasks} tâche(s) sur 30 j · <b>{fmtNum(d.tokens.balance)} jetons</b></p>
      <h4 style={{ margin: 0 }}>Abonnements</h4><Table head={['Offre', 'Début', 'Fin']} rows={d.subscriptions.map((s: any) => [s.plan_code, fmtDate(s.starts_at), fmtDate(s.ends_at)])} empty="Aucun." />
      <h4 style={{ margin: 0 }}>Paiements</h4><Table head={['Date', 'Réf.', 'Offre', 'Montant', 'Moyen', 'État']} rows={d.payments.map((p: any) => [fmtDate(p.created_at), p.provider_ref, p.plan_code, fmtMoney(p.amount, p.currency), p.channel, <StatusChip key="s" s={p.status} />])} empty="Aucun." />
      <h4 style={{ margin: 0 }}>Jetons (20 derniers mouvements)</h4><Table head={['Date', 'Quantité', 'Solde après', 'Type', 'Note']} rows={d.tokens.history.map((h: any) => [fmtDate(h.created_at), h.delta, h.balance_after, h.reason, h.note ?? ''])} empty="Aucun." />
      <h4 style={{ margin: 0 }}>Réseaux connectés</h4><Table head={['Plateforme', 'Compte', 'État', 'Dernière synchro']} rows={d.social.map((s: any) => [s.platform, s.display_name, s.status, fmtDate(s.synced_at)])} empty="Aucun." />
      <h4 style={{ margin: 0 }}>Publications</h4><Table head={['Date', 'Plateforme', 'État', 'Auteur', 'Extrait']} rows={d.posts.map((p: any) => [fmtDate(p.created_at), p.platform, p.status, p.created_by, p.excerpt])} empty="Aucune." />
      <h4 style={{ margin: 0 }}>Connexions récentes</h4><Table head={['Date', 'IP', 'Résultat', 'Détail']} rows={d.logins.map((l: any) => [fmtDate(l.created_at), l.ip, l.success ? 'réussie' : 'échec', l.reason ?? ''])} empty="Aucune." />
    </div>)}
  </div>);
}
