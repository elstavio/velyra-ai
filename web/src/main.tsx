import { Fragment, StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, tokens } from './api';
import { Forgot, Landing, Legal, Login, Register } from './public';
import { ComplianceCenter, TransparencyBanner } from './compliance';
import { Account as _A } from './app2';
import { Agents, Chat, Dashboard, Documents, Memory, type Me } from './app1';
import { Account, Developer, Marketplace, PaymentReturn, Pricing, TikTok, Workflows } from './app2';
import { ADMIN_GROUPS, AdminConsole, AdminLogin, TABS } from './admin';
import { Social } from './social';
import { ErrorBoundary, Loading, Modal, go, useHash } from './ui';

const NAV: [string, string, string][] = [['/app', 'Accueil', '⌂'], ['/app/chat', 'Discuter', '✎'], ['/app/memoire', 'Mémoire', '◉'], ['/app/documents', 'Documents', '▤'], ['/app/agents', 'Agents', '☺'], ['/app/workflows', 'Workflows', '⇉'], ['/app/marketplace', 'Marketplace', '❖'], ['/app/reseaux', 'Réseaux', '◎'], ['/app/tiktok', 'TikTok', '♪'], ['/offres', 'Offres', '€'], ['/app/api', 'API', '⌘'], ['/app/compte', 'Compte', '☰']];
void _A;

// M2 (Phase 4) : glyphes de la barre mobile (.tabbar) pour les 15 sections admin, construits à partir
// de admin.tsx::TABS (source unique des libellés/clés) — aucun doublon, aucune icône SVG (hors scope M2/M4).
const ADMIN_ICON: Record<string, string> = { '': '▦', utilisateurs: '☺', paiements: '€', portefeuille: '◆', fraude: '⚠', securite: '⌘', controles: '✓', agents: '✎', finances: '▤', jetons: '●', reseaux: '◎', ia: '✺', marketplace: '❖', offres: '☰', systeme: '⚙' };
// M3 : table clé -> [href, libellé, icône], pour que le menu mobile groupé (Modal ci-dessous) retrouve
// chaque entrée par clé dans l'ordre des groupes (ADMIN_GROUPS, admin.tsx) SANS changer ADMIN_NAV ni son
// ordre d'origine (celui de TABS) — activeAdminItem juste en dessous continue de parcourir ADMIN_NAV
// strictement inchangé, donc sa résolution par préfixe le plus long (ex. /admin/securite/intrusion) n'est
// pas affectée par le regroupement, qui ne touche que l'affichage.
const ADMIN_NAV_BY_KEY: Record<string, [string, string, string]> = Object.fromEntries(TABS.map(([k, l]) => [k, [`/admin${k ? '/' + k : ''}`, l, ADMIN_ICON[k] ?? '•']]));
const ADMIN_NAV: [string, string, string][] = TABS.map(([k]) => ADMIN_NAV_BY_KEY[k]);

// M2-correction : trouve l'entrée ADMIN_NAV correspondant au chemin courant par préfixe le plus long
// (pas une égalité stricte, car une section admin peut porter un sous-chemin, ex. "/admin/securite/intrusion"
// doit rattacher "Sécurité", pas rater la correspondance). Sert au libellé du bouton déclencheur mobile et
// au marquage de l'élément actif dans le menu — voir Shell ci-dessous.
function activeAdminItem(path: string): [string, string, string] {
  let best: [string, string, string] | null = null;
  for (const it of ADMIN_NAV) { if (path === it[0] || path.startsWith(it[0] + '/')) { if (!best || it[0].length > best[0].length) best = it; } }
  return best ?? ADMIN_NAV[0];
}

// M2 (Phase 4), corrigé après livraison : prop `admin` ajoutée (rétrocompatible — tous les appels existants
// sans cette prop sont inchangés). Quand `admin` est vrai : la nav desktop de l'en-tête n'est pas rendue
// (elle resterait la SEULE navigation de premier niveau si on l'affichait avec 15 libellés — risque de
// retour à la ligne dans l'en-tête sticky — et ferait doublon avec la nav interne à 15 sections déjà rendue
// par AdminConsole/.tabs juste sous le titre « Administration », qui reste la hiérarchie de référence :
// « navigation principale » = chrome du Shell, « navigation interne à l'administration » = ce .tabs
// existant, inchangé en desktop) ; le bouton Déconnexion de l'en-tête est masqué (celui déjà présent dans
// AdminConsole reste l'unique bouton, pas de doublon) ; le bandeau de transparence (cookies, grand public)
// n'est pas affiché dans cet espace interne.
// Correction (retour utilisateur après livraison M2) : sur mobile, .tabbar affichait une seconde fois les
// 15 sections déjà listées par AdminConsole/.tabs juste au-dessus — deux navigations identiques, surcharge
// l'écran. En mode admin, .tabbar porte désormais UN SEUL bouton (section active + libellé), qui ouvre le
// composant Modal existant (M1, non modifié) listant les 15 sections — une seule navigation visible à la
// fois, compacte, et la nav interne .tabs.admin-top-tabs correspondante est masquée sous 860px (styles.css)
// pour qu'aucune des deux ne fasse doublon. Desktop strictement inchangé (.tabbar reste masquée ≥860px).
function Shell({ path, children, onLogout, admin }: { path: string; children: React.ReactNode; onLogout?: () => void; admin?: boolean }) {
  const items = admin ? ADMIN_NAV : NAV;
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [path]);
  const active = admin ? activeAdminItem(path) : null;
  return (<>
    <a className="sr" href="#contenu">Aller au contenu</a>
    <header className="top"><div className="wrap"><a className="brand" href={onLogout ? (admin ? '#/admin' : '#/app') : '#/'}><i aria-hidden="true" />Velyra AI{admin ? ' · admin' : ''}</a>
      {onLogout ? <>{!admin && <nav aria-label="Principal">{items.map(([p, l]) => <a key={p} href={`#${p}`} className={path === p ? 'on' : ''} aria-current={path === p ? 'page' : undefined}>{l}</a>)}</nav>}<span style={{ flex: 1 }} /></> : <span style={{ flex: 1 }} />}
      {onLogout ? (!admin && <button className="btn sm" onClick={onLogout}>Déconnexion</button>) : (!admin && <a className="btn sm" href="#/connexion">Connexion</a>)}</div></header>
    <main className="page" id="contenu">{!admin && <TransparencyBanner />}{children}</main>
    <footer className="wrap tiny" style={{ paddingBottom: onLogout ? 90 : 24 }}><a href="#/confidentialite">Confidentialité</a> · <a href="#/conditions">Conditions d'utilisation</a> · <a href="#/conformite">Centre de conformité</a></footer>
    {onLogout && (admin
      ? <nav className="tabbar" aria-label="Navigation mobile"><button type="button" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><b aria-hidden="true">{active![2]}</b>{active![1]}<span aria-hidden="true" className="chev">▾</span></button></nav>
      : <nav className="tabbar" aria-label="Navigation mobile">{items.map(([p, l, i]) => <a key={p} href={`#${p}`} className={path === p ? 'on' : ''} aria-current={path === p ? 'page' : undefined}><b aria-hidden="true">{i}</b>{l}</a>)}</nav>)}
    {admin && menuOpen && (
      <Modal onClose={() => setMenuOpen(false)} ariaLabel="Sections de l'administration">
        <h3 style={{ marginTop: 0 }}>Sections</h3>
        {/* M3 : même liste plate de 15 <a> qu'avant (mêmes hrefs/libellés/icônes), désormais parcourue par
            groupe (ADMIN_GROUPS) avec un <p> de titre non interactif entre chaque groupe — aucun second
            niveau de navigation, le Modal M1 et son comportement (piège de focus, restauration, Échap)
            restent strictement inchangés : seul le contenu passé en children change. */}
        <nav className="admin-menu-list" aria-label="Sections de l'administration">
          {ADMIN_GROUPS.map(([gl, keys]) => (
            <Fragment key={gl}>
              <p className="admin-menu-group">{gl}</p>
              {keys.map((k) => { const [p, l, i] = ADMIN_NAV_BY_KEY[k]; return <a key={p} href={`#${p}`} className={active![0] === p ? 'on' : ''} aria-current={active![0] === p ? 'page' : undefined} onClick={() => setMenuOpen(false)}><b aria-hidden="true">{i}</b>{l}</a>; })}
            </Fragment>
          ))}
        </nav>
      </Modal>
    )}
  </>);
}

function App() {
  const hash = useHash(); const path = hash.split('?')[0];
  const [cfg, setCfg] = useState<any>(null); const [me, setMe] = useState<Me | null>(null); const [auth, setAuth] = useState(!!tokens.user()); const [adminAuth, setAdminAuth] = useState(!!tokens.admin());
  const [, tick] = useState(0);
  useEffect(() => { api('/api/config').then(setCfg).catch(() => setCfg({})); }, []);
  useEffect(() => { const f = () => { setAuth(!!tokens.user()); setAdminAuth(!!tokens.admin()); tick((n) => n + 1); }; addEventListener('vly-auth', f); return () => removeEventListener('vly-auth', f); }, []);
  const loadMe = useCallback(() => { if (!tokens.user()) { setMe(null); return; } api('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { loadMe(); }, [auth, loadMe]);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined); tokens.setUser(null); setAuth(false); setMe(null); go('/'); };
  const onAuth = () => { setAuth(!!tokens.user()); setAdminAuth(!!tokens.admin()); };

  // Administration (interface séparée, session distincte)
  // M2 (Phase 4) : intégrée au Shell commun (lien d'évitement, pied de page, mécanisme .tabbar) via la
  // prop `admin` — voir le commentaire sur Shell ci-dessus pour le détail du comportement en mode admin.
  if (path.startsWith('/admin')) {
    if (path === '/admin/connexion' || !adminAuth) return <Shell path={path} admin><AdminLogin onAuth={onAuth} /></Shell>;
    // `onLogout` ici n'est qu'un marqueur de mise en page « connecté » (nav/.tabbar/pied de page) pour
    // Shell — il n'est jamais invoqué : le véritable bouton Déconnexion reste celui d'AdminConsole
    // ci-dessous (inchangé), pour ne jamais en afficher deux.
    return <Shell path={path} admin onLogout={() => {}}><AdminConsole tab={path.replace(/^\/admin\/?/, '')} onLogout={onAuth} /></Shell>;
  }
  if (path.startsWith('/paiement/retour/')) {
    if (!auth) return <Shell path={path}><div className="wrap"><p>Connectez-vous pour voir l'état de votre paiement. <a href="#/connexion">Connexion</a></p></div></Shell>;
    return <Shell path={path} onLogout={logout}><PaymentReturn ref_={decodeURIComponent(path.split('/').pop() ?? '')} reload={loadMe} /></Shell>;
  }
  if (path === '/confidentialite' || path === '/conditions') return <Shell path={path} onLogout={auth ? logout : undefined}><Legal page={path.slice(1) as 'confidentialite' | 'conditions'} /></Shell>;
  // I4 : "/conformite" peut désormais porter un sous-chemin (ex. "/conformite/cookies") pour le lien direct
  // vers l'une des 10 sections — même convention que "/admin/<section>" ci-dessus (path.startsWith +
  // sous-chemin transmis en prop à ComplianceCenter, qui en extrait elle-même la section active).
  if (path === '/conformite' || path.startsWith('/conformite/')) return <Shell path={path} onLogout={auth ? logout : undefined}><ComplianceCenter tab={path.replace(/^\/conformite\/?/, '')} /></Shell>;
  const isPrivate = path.startsWith('/app') || path === '/offres';
  if (!isPrivate) {
    if (path === '/connexion') return <Shell path={path}><Login cfg={cfg} onAuth={onAuth} /></Shell>;
    if (path === '/inscription') return <Shell path={path}><Register cfg={cfg} onAuth={onAuth} /></Shell>;
    if (path === '/mot-de-passe-oublie') return <Shell path={path}><Forgot /></Shell>;
    return <Shell path={path}><Landing cfg={cfg} /></Shell>;
  }
  if (!auth) { return <Shell path={path}><Login cfg={cfg} onAuth={onAuth} /></Shell>; }
  if (!me) return <Shell path={path} onLogout={logout}><div className="wrap"><Loading /></div></Shell>;
  const page = (() => {
    switch (path) {
      case '/app/chat': return <Chat reload={loadMe} />;
      case '/app/memoire': return <Memory />;
      case '/app/documents': return <Documents />;
      case '/app/agents': return <Agents />;
      case '/app/workflows': return <Workflows />;
      case '/app/marketplace': return <Marketplace />;
      case '/app/reseaux': return <Social me={me} reload={loadMe} />;
      case '/app/tiktok': return <TikTok me={me} />;
      case '/offres': return <Pricing me={me} cfg={cfg} reload={loadMe} />;
      case '/app/api': return <Developer />;
      case '/app/compte': return <Account me={me} reload={loadMe} onLogout={logout} />;
      default: return <Dashboard me={me} cfg={cfg} reload={loadMe} />;
    }
  })();
  return <Shell path={path} onLogout={logout}><div className="wrap">{page}</div></Shell>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
