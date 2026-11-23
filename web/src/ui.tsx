import { Component, useEffect, useRef, useState, type CSSProperties, type ErrorInfo, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from './api';

/**
 * Filet de sécurité (§2.8) : si un composant plante au rendu, React démonte tout l'arbre et l'écran reste blanc
 * sans ce filet. On affiche un message clair plutôt qu'une page vide, et on journalise l'erreur pour la retrouver.
 */
interface EBState { error: Error | null }
export class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erreur d\'affichage :', error, info.componentStack);
    try {
      fetch('/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ message: String(error?.message ?? error).slice(0, 500), stack: String(error?.stack ?? '').slice(0, 2000), where: location.hash }) }).catch(() => undefined);
    } catch { /* ne jamais laisser la journalisation casser l'affichage de secours */ }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="wrap" style={{ padding: '48px 16px', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.4rem' }}>Une erreur inattendue s'est produite</h1>
        <p className="muted" style={{ maxWidth: 440, margin: '8px auto 20px' }}>L'incident a été signalé. Rechargez la page ; si le problème persiste, contactez le support.</p>
        <button className="btn primary" onClick={() => location.reload()}>Recharger la page</button>
      </div>
    );
  }
}

export function useHash() {
  const [h, setH] = useState(location.hash.slice(1) || '/');
  useEffect(() => { const f = () => { setH(location.hash.slice(1) || '/'); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}
export const go = (p: string) => { location.hash = p; };

/**
 * I5 : navigation au clavier d'un groupe d'onglets ARIA (flèches/Home/End), motif « roving tabindex »
 * recommandé par WAI-ARIA Authoring Practices. À poser en onKeyDown sur chaque élément role="tab" :
 * les flèches déplacent le focus vers l'onglet voisin (Home/End vers le premier/dernier) et activent sa
 * sélection existante via .click() — aucune logique de sélection dupliquée ici, uniquement la navigation.
 */
export function rovingTabsKeyDown(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const el = e.currentTarget;
  const siblings = Array.from(el.parentElement?.children ?? []) as HTMLElement[];
  const i = siblings.indexOf(el);
  if (i < 0) return;
  let j = i;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % siblings.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + siblings.length) % siblings.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = siblings.length - 1;
  siblings[j]?.focus();
  siblings[j]?.click();
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true);
    fn().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(msg(e)); }).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1), set: setData };
}
export const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Erreur inattendue');

export function Alert({ kind, children }: { kind?: 'err' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`alert ${kind ?? ''}`} role={kind === 'err' ? 'alert' : 'status'}>{children}</div>;
}
export function Err({ error }: { error: string | null }) { return error ? <Alert kind="err">{error}</Alert> : null; }
export function Loading() { return <p className="muted" role="status">Chargement…</p>; }

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="f"><span>{label}</span>{children}{hint && <small className="tiny">{hint}</small>}</label>;
}

/** Bouton qui exécute une action asynchrone et affiche l'erreur à côté. */
export function useAction() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true); setError(null); setOk(null);
    try { const r = await fn(); if (okMsg) setOk(okMsg); return r; } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  };
  return { busy, error, ok, run, clear: () => { setError(null); setOk(null); } };
}

/**
 * M1 (Phase 4) : fenêtre modale accessible, partagée par toute l'application — extraite de l'ancien
 * ReviewModal (web/src/social.tsx), qui n'était qu'un <div role="dialog" aria-modal="true"> sans aucune
 * gestion réelle du focus (pas de piège, pas de restitution, pas de fermeture au clavier) : le constat a été
 * vérifié par relecture du code avant extraction, ce n'est donc pas une régression de ce qui existait. Les
 * comportements ci-dessous (piège de focus, restitution du focus au déclencheur, fermeture via Échap et via
 * un clic sur la trame de fond, blocage du défilement/de l'interaction avec le contenu situé derrière) sont
 * donc de véritables nouveautés apportées par ce composant, et non une préservation d'un comportement
 * préexistant. Ce composant ne porte aucune logique métier : il fournit uniquement la coquille (trame de
 * fond, carte, piège de focus, ARIA, responsive, animation d'entrée via la classe .pop déjà existante et
 * respectueuse de prefers-reduced-motion). Le contenu (cases à cocher, champ de saisie, boutons, empreinte
 * de contenu, etc.) reste entièrement à la charge de l'appelant.
 */
export function Modal({ onClose, ariaLabel, labelledBy, describedBy, children, wide }: {
  /** Absent (undefined) = fenêtre non fermable par Échap/clic sur la trame de fond/croix (ex. requête en cours). */
  onClose?: () => void;
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const root = ref.current;
    const focusables = () => Array.from(root?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ) ?? []);
    (focusables()[0] ?? root)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (onClose) { e.preventDefault(); onClose(); } return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const idx = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey ? idx <= 0 : (idx === f.length - 1 || idx === -1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    };
    document.addEventListener('keydown', onKey as unknown as EventListener, true);
    const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey as unknown as EventListener, true);
      document.body.style.overflow = prevOverflow;
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div ref={ref} className={`card modal pop${wide ? ' wide' : ''}`} role="dialog" aria-modal="true"
        aria-label={labelledBy ? undefined : ariaLabel} aria-labelledby={labelledBy} aria-describedby={describedBy} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

/**
 * M1 (Phase 4) : remplace les window.confirm()/window.prompt() natifs par une fenêtre modale accessible
 * (construite sur Modal ci-dessus), avec gestion d'erreur en ligne et état de chargement — contrairement à
 * un window.confirm() natif, l'appel API s'exécute pendant que la fenêtre reste ouverte (le bouton se
 * désactive, « Annuler » et Échap sont désactivés le temps de la requête — empêche toute double soumission),
 * et une erreur serveur s'affiche dans la fenêtre au lieu d'une alerte navigateur séparée.
 * Usage : const { ask, node } = useConfirm(); … ask({ title, message, onConfirm: async () => { await api(...); } }); … return <>{node}{reste du composant}</>;
 */
export type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style le bouton de confirmation comme une action destructrice (classe .btn.danger déjà existante). */
  danger?: boolean;
  /** Présence = remplace un window.prompt() : affiche un vrai champ de saisie libellé, jamais une simple case à cocher. */
  fieldLabel?: string;
  fieldPlaceholder?: string;
  fieldType?: 'text' | 'textarea';
  fieldDefault?: string;
  /** Par défaut (ou true) : le champ est requis, le bouton de confirmation reste désactivé tant qu'il est
   *  vide — cas des motifs obligatoires (ex. suspension/révocation de compte). Mettre à false pour un champ
   *  réellement facultatif (ex. note de décision anti-fraude) : la confirmation reste alors possible même
   *  champ vide, exactement comme l'ancien window.prompt() facultatif qu'il remplace. */
  fieldRequired?: boolean;
  /** value vaut la saisie du champ (ou '' en l'absence de fieldLabel, équivalent d'un window.confirm()). */
  onConfirm: (value: string) => Promise<void>;
};
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [value, setValue] = useState('');
  const a = useAction();
  const ask = (o: ConfirmOptions) => { setValue(o.fieldDefault ?? ''); a.clear(); setOpts(o); };
  const close = () => setOpts(null);
  const fieldRequired = !!opts?.fieldLabel && opts.fieldRequired !== false;
  const fieldEmpty = fieldRequired && !value.trim();
  const node = opts ? (
    <Modal ariaLabel={opts.title} onClose={a.busy ? undefined : close}>
      <h3 style={{ marginTop: 0 }}>{opts.title}</h3>
      {opts.message && <p className="tiny">{opts.message}</p>}
      {opts.fieldLabel && (
        <Field label={opts.fieldLabel}>
          {opts.fieldType === 'textarea'
            ? <textarea rows={3} autoFocus required={fieldRequired} value={value} placeholder={opts.fieldPlaceholder} onChange={(e) => setValue(e.target.value)} />
            : <input autoFocus required={fieldRequired} value={value} placeholder={opts.fieldPlaceholder} onChange={(e) => setValue(e.target.value)} />}
        </Field>
      )}
      <Err error={a.error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className={`btn primary${opts.danger ? ' danger' : ''}`} disabled={a.busy || fieldEmpty}
          onClick={() => a.run(async () => { await opts.onConfirm(value); close(); })}>
          {a.busy ? 'Veuillez patienter…' : (opts.confirmLabel ?? 'Confirmer')}
        </button>
        <button type="button" className="btn" disabled={a.busy} onClick={close}>{opts.cancelLabel ?? 'Annuler'}</button>
      </div>
    </Modal>
  ) : null;
  return { ask, node, busy: a.busy };
}

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtMoney = (n: number, cur: string) => `${new Intl.NumberFormat('fr-FR').format(n)} ${cur}`;
export const fmtNum = (n: number) => new Intl.NumberFormat('fr-FR').format(n);

export function StatusChip({ s }: { s: string }) {
  // F6 : statuts couvrants, verifies un par un dans le code serveur (server/services/*.ts,
  // server/providers/stripe.ts) avant d'etre classes ici. Un statut absent des 3 listes
  // reste neutre (chip sans couleur) : c'est le cas voulu pour 'skipped' (sysagents.ts),
  // que le serveur lui-meme traite comme non problematique (il n'entre ni dans le calcul
  // d'echec ni dans celui de degradation de SuperCheck), et pour tout statut futur non
  // encore identifie ici.
  const good = ['succeeded', 'sent', 'confirmed', 'active', 'approved', 'done', 'ok',
    'manual_done', 'no_payment_required', 'paid', 'published'].includes(s);
  const bad = ['failed', 'abandoned', 'rejected', 'revoked', 'suspended', 'critical', 'high', 'review',
    'discarded', 'expired', 'mismatch', 'reconnect'].includes(s);
  const warn = ['pending', 'held', 'sending', 'medium', 'open',
    'degraded', 'draft', 'incomplete', 'publishing', 'queued', 'running'].includes(s);
  return <span className={`chip ${good ? 'good' : bad ? 'bad' : warn ? 'warn' : ''}`}>{s}</span>;
}

export function Table({ head, rows, empty = 'Rien à afficher pour le moment.' }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  // I6 : rôles ARIA explicites + data-label sur chaque cellule. Sous 480px (voir styles.css), ce tableau
  // passe en cartes empilées par un changement purement visuel de CSS "display" — or les navigateurs
  // retirent la sémantique ARIA de tableau implicite dès que "display" n'est plus table/table-row/
  // table-cell, ce qui romprait la navigation par tableau des lecteurs d'écran en dessous de ce seuil.
  // Les rôles sont posés inconditionnellement (corrects à toute largeur, pas seulement en media query) :
  // un rôle explicite identique au rôle implicite ne change rien pour un lecteur d'écran au-delà de 480px.
  // "data-label" fournit l'étiquette visuelle de chaque cellule en mode carte ; une colonne sans en-tête
  // (boutons d'action) n'en reçoit pas (head[j] vide → attribut omis), ce qui est volontaire : ces cellules
  // s'expliquent déjà par elles-mêmes (icône, libellé de bouton).
  return <div className="tablewrap"><table role="table"><thead role="rowgroup"><tr role="row">{head.map((h) => <th key={h} role="columnheader" scope="col">{h}</th>)}</tr></thead><tbody role="rowgroup">{rows.map((r, i) => <tr role="row" key={i}>{r.map((c, j) => <td role="cell" key={j} data-label={head[j] || undefined}>{c}</td>)}</tr>)}</tbody></table></div>;
}

/** Histogramme simple, accessible : chaque barre pousse depuis le bas au premier affichage, infobulle réelle au
 *  survol/focus (en plus du title, gardé pour les lecteurs d'écran et l'impression). */
export function Bars({ data, label, format = fmtNum }: { data: { k: string; v: number }[]; label: string; format?: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <figure style={{ margin: 0 }} aria-label={label}>
      <div className="bars" role="img" aria-label={`${label} : ${data.map((d) => `${d.k} ${format(d.v)}`).join(', ')}`}>
        {hover != null && data[hover] && <span className="chart-tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%`, top: 0 }}>{data[hover].k} · {format(data[hover].v)}</span>}
        {data.map((d, i) => (
          <i key={d.k} title={`${d.k} : ${format(d.v)}`} tabIndex={0}
            style={{ height: `${Math.max(2, (d.v / max) * 100)}%`, '--i': i } as CSSProperties}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
        ))}
      </div>
      <figcaption className="tiny row between"><span>{data[0]?.k}</span><span>max {format(max)}</span><span>{data[data.length - 1]?.k}</span></figcaption>
    </figure>
  );
}

/** Nombre qui s'anime une fois jusqu'à sa valeur réelle (jamais de valeur inventée en cours de route : part de 0,
 *  monte jusqu'à la vraie donnée reçue de l'API). Respecte prefers-reduced-motion (saut direct à la valeur finale). */
export function CountUp({ value, format = fmtNum }: { value: number; format?: (n: number) => string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setN(value); return; }
    let raf = 0; const start = performance.now(); const dur = 700;
    const step = (t: number) => { const p = Math.min(1, (t - start) / dur); setN(Math.round(value * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="countup" key={value}>{format(n)}</span>;
}

/** Anneau de progression SVG (ex. essai gratuit restant). pct entre 0 et 100. */
export function Ring({ pct, big, small }: { pct: number; big: ReactNode; small: ReactNode }) {
  const r = 42; const c = 2 * Math.PI * r; const off = c - (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 104 104"><circle className="track" cx={52} cy={52} r={r} /><circle className="fill" cx={52} cy={52} r={r} strokeDasharray={c} style={{ strokeDashoffset: off, '--ring-from': c, '--ring-to': off } as CSSProperties} /></svg>
      {/* I2 : .bignum.xs remplace l'ancien style inline dupliqué (même famille/graisse/tabular-nums que les autres grands chiffres, taille réduite pour tenir dans l'anneau) */}
      <div className="mid"><b className="bignum xs">{big}</b><span className="tiny">{small}</span></div>
    </div>
  );
}

/** Aire/ligne de tendance sur une série temporelle courte (ex. 14 jours), avec infobulle au survol. */
export function AreaTrend({ data, label, format = fmtNum, height = 120 }: { data: { k: string; v: number }[]; label: string; format?: (n: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 600; const max = Math.max(1, ...data.map((d) => d.v));
  const pt = (i: number) => [data.length > 1 ? (i / (data.length - 1)) * w : w / 2, height - (data[i].v / max) * (height - 14) - 6] as const;
  const line = data.map((_, i) => pt(i).join(',')).join(' ');
  const area = `0,${height} ${line} ${w},${height}`;
  const h = hover ?? -1;
  return (
    <figure style={{ margin: 0 }} aria-label={label}>
      <div className="area-wrap" role="img" aria-label={`${label} : ${data.map((d) => `${d.k} ${format(d.v)}`).join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * w; const i = Math.max(0, Math.min(data.length - 1, Math.round((x / w) * (data.length - 1)))); setHover(i); }}>
        <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
          <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--gold-bright)" stopOpacity="0.32" /><stop offset="100%" stopColor="var(--gold-bright)" stopOpacity="0" /></linearGradient></defs>
          <polygon className="fill" points={area} />
          <polyline className="line" points={line} style={{ strokeDasharray: 2000, '--len': 2000 } as CSSProperties} />
          {h >= 0 && <line x1={pt(h)[0]} x2={pt(h)[0]} y1={0} y2={height} stroke="var(--line)" strokeDasharray="3,3" />}
          {data.map((_, i) => { const [x, y] = pt(i); return <circle key={i} className="dot" cx={x} cy={y} r={h === i ? 4 : 0} />; })}
        </svg>
        {h >= 0 && <span className="chart-tip" style={{ left: `${(pt(h)[0] / w) * 100}%`, top: `${(pt(h)[1] / height) * 100}%` }}>{data[h].k} · {format(data[h].v)}</span>}
      </div>
      <figcaption className="tiny row between"><span>{data[0]?.k}</span><span>{data[data.length - 1]?.k}</span></figcaption>
    </figure>
  );
}

/**
 * Palette du donut : 4 couleurs fixes. Au-delà de 4 catégories dans `data`,
 * les couleurs sont réutilisées de façon cyclique (voir `i % DONUT_COLORS.length`
 * plus bas) : une 5e catégorie reprend la couleur de la 1re, une 6e celle de la
 * 2e, etc. Les catégories restent distinguées par leur libellé dans la légende,
 * mais plus par la couleur seule au-delà de 4 entrées. Limite connue et
 * volontairement conservée ici (F5) : étendre la palette ou changer ce
 * comportement est une décision à valider séparément, pas un changement
 * arbitraire à faire au passage.
 */
const DONUT_COLORS = ['var(--gold-bright)', 'var(--cat-2)', 'var(--cat-3)', 'var(--ink-3)'];
/** Diagramme en anneau pour une répartition catégorielle (ex. type de tâche). */
export function Donut({ data, label }: { data: { k: string; v: number }[]; label: string }) {
  const total = Math.max(1, data.reduce((s, d) => s + d.v, 0));
  const r = 40; const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="donut-wrap" role="img" aria-label={`${label} : ${data.map((d) => `${d.k} ${d.v}`).join(', ')}`}>
      <svg width={104} height={104} viewBox="0 0 104 104">
        <circle cx={52} cy={52} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={14} />
        {data.map((d, i) => {
          const frac = d.v / total; const len = frac * c; const dash = `${len} ${c - len}`; const offset = c - acc; acc += len;
          return <circle key={d.k} className="seg" cx={52} cy={52} r={r} fill="none" stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth={14} strokeDasharray={dash} strokeDashoffset={offset} />;
        })}
      </svg>
      <div className="donut-legend">
        {data.map((d, i) => <div key={d.k} className="row"><i style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} /><span>{d.k}</span><span className="muted" style={{ marginLeft: 'auto' }}>{d.v}</span></div>)}
      </div>
    </div>
  );
}
