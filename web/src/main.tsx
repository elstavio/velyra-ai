import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, tokens } from './api';
import { Forgot, Landing, Legal, Login, Register } from './public';
import { ComplianceCenter, TransparencyBanner } from './compliance';
import { Account as _A } from './app2';
import { Agents, Chat, Dashboard, Documents, Memory, type Me } from './app1';
import { Account, Developer, Marketplace, PaymentReturn, Pricing, TikTok, Workflows } from './app2';
import { AdminConsole, AdminLogin } from './admin';
import { Social } from './social';
import { ErrorBoundary, Loading, go, useHash } from './ui';

const NAV: [string, string, string][] = [['/app', 'Accueil', '⌂'], ['/app/chat', 'Discuter', '✎'], ['/app/memoire', 'Mémoire', '◉'], ['/app/documents', 'Documents', '▤'], ['/app/agents', 'Agents', '☺'], ['/app/workflows', 'Workflows', '⇉'], ['/app/marketplace', 'Marketplace', '❖'], ['/app/reseaux', 'Réseaux', '◎'], ['/app/tiktok', 'TikTok', '♪'], ['/offres', 'Offres', '€'], ['/app/api', 'API', '⌘'], ['/app/compte', 'Compte', '☰']];
void _A;

function Shell({ path, children, onLogout }: { path: string; children: React.ReactNode; onLogout?: () => void }) {
  return (<>
    <a className="sr" href="#contenu">Aller au contenu</a>
    <header className="top"><div className="wrap"><a className="brand" href={onLogout ? '#/app' : '#/'}><i aria-hidden="true" />Velyra AI</a>
      {onLogout ? <><nav aria-label="Principal">{NAV.map(([p, l]) => <a key={p} href={`#${p}`} className={path === p ? 'on' : ''} aria-current={path === p ? 'page' : undefined}>{l}</a>)}</nav><span style={{ flex: 1 }} /></> : <span style={{ flex: 1 }} />}
      {onLogout ? <button className="btn sm" onClick={onLogout}>Déconnexion</button> : <a className="btn sm" href="#/connexion">Connexion</a>}</div></header>
    <main className="page" id="contenu"><TransparencyBanner />{children}</main>
    <footer className="wrap tiny" style={{ paddingBottom: onLogout ? 90 : 24 }}><a href="#/confidentialite">Confidentialité</a> · <a href="#/conditions">Conditions d'utilisation</a> · <a href="#/conformite">Centre de conformité</a></footer>
    {onLogout && <nav className="tabbar" aria-label="Navigation mobile">{NAV.map(([p, l, i]) => <a key={p} href={`#${p}`} className={path === p ? 'on' : ''} aria-current={path === p ? 'page' : undefined}><b aria-hidden="true">{i}</b>{l}</a>)}</nav>}
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
  if (path.startsWith('/admin')) {
    if (path === '/admin/connexion' || !adminAuth) return <><header className="top"><div className="wrap"><a className="brand" href="#/"><i aria-hidden="true" />Velyra AI</a></div></header><main className="page"><AdminLogin onAuth={onAuth} /></main></>;
    return <><header className="top"><div className="wrap"><a className="brand" href="#/admin"><i aria-hidden="true" />Velyra AI · admin</a></div></header><main className="page" id="contenu"><AdminConsole tab={path.replace(/^\/admin\/?/, '')} onLogout={onAuth} /></main></>;
  }
  if (path.startsWith('/paiement/retour/')) {
    if (!auth) return <Shell path={path}><div className="wrap"><p>Connectez-vous pour voir l'état de votre paiement. <a href="#/connexion">Connexion</a></p></div></Shell>;
    return <Shell path={path} onLogout={logout}><PaymentReturn ref_={decodeURIComponent(path.split('/').pop() ?? '')} reload={loadMe} /></Shell>;
  }
  if (path === '/confidentialite' || path === '/conditions') return <Shell path={path} onLogout={auth ? logout : undefined}><Legal page={path.slice(1) as 'confidentialite' | 'conditions'} /></Shell>;
  if (path === '/conformite') return <Shell path={path} onLogout={auth ? logout : undefined}><ComplianceCenter /></Shell>;
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
