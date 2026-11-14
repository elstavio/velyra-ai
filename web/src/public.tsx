import { useEffect, useRef, useState } from 'react';
import { api, tokens } from './api';
import { Alert, Field, go, msg, useAction, useAsync } from './ui';

export function Landing({ cfg }: { cfg: any }) {
  const plans = useAsync(() => api('/api/plans'));
  return (
    <div className="wrap fadein">
      <section className="hero">
        <div>
          <h1>Votre assistant IA, vos documents et vos agents au même endroit.</h1>
          <p className="lead">Velyra AI garde en mémoire ce que vous lui demandez de retenir, cherche dans vos documents, exécute des enchaînements de tâches et analyse vos statistiques TikTok. Payez par Mobile Money ou carte.</p>
          <div className="row"><a className="btn primary" href="#/inscription">Essayer {cfg?.trialTasks ?? 5} tâches gratuites</a><a className="btn" href="#/connexion">Se connecter</a></div>
          <p className="tiny" style={{ marginTop: 10 }}>Les essais gratuits demandent un email et un numéro de téléphone confirmés (un compte par numéro).</p>
        </div>
        <div className="card" aria-hidden="true">
          <div className="convo">
            <div className="bubble u">Rappelle-moi : je vends des pagnes à Abidjan, clientèle 25-40 ans.</div>
            <div className="bubble a">C'est noté. Je m'en servirai dans vos prochaines conversations.</div>
            <div className="bubble u">Écris 3 légendes TikTok pour ma nouvelle collection.</div>
            <div className="bubble a">1. Nouvelle collection, nouveaux motifs. Lesquels vous attendent à Cocody ? …</div>
          </div>
        </div>
      </section>
      <section className="grid" style={{ paddingBottom: 24 }}>
        {[
          ['Conversations avec mémoire', 'Vous choisissez ce que l\'assistant retient (100 souvenirs maximum) et vous pouvez tout effacer.'],
          ['Documents', 'Importez vos textes et retrouvez les passages utiles. La recherche est lexicale (mots-clés), pas sémantique.'],
          ['Agents et workflows', 'Créez des assistants spécialisés et enchaînez jusqu\'à 8 étapes ; chaque étape compte comme une tâche.'],
          ['Analyse TikTok', 'À partir des chiffres que vous saisissez ou importez en CSV. Aucune connexion à TikTok, aucune promesse de viralité.'],
        ].map(([t, d]) => <div className="card" key={t}><h3>{t}</h3><p className="muted" style={{ margin: 0 }}>{d}</p></div>)}
      </section>
      <section style={{ paddingBottom: 40 }}>
        <h2>Offres</h2>
        {plans.data && <div className="grid">{(plans.data as any).plans.filter((p: any) => !(p.features ?? []).some((f: string) => f.startsWith('tokens:'))).map((p: any) => (
          <div className="card" key={p.code}><h3>{p.name}</h3><p className="muted">{p.description}</p>
            <p className="tiny">Durée : {p.durationDays} jours. Le prix s'affiche dans votre devise après inscription.</p></div>))}</div>}
      </section>
    </div>
  );
}

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="wrap" style={{ maxWidth: 440, paddingTop: 28 }}><div className="card"><h2>{title}</h2>{children}</div></div>;
}

export function Login({ cfg, onAuth }: { cfg: any; onAuth: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const a = useAction();
  const [mode, setMode] = useState<'password' | 'code'>('password'); const [codeSent, setCodeSent] = useState(false); const [code, setCode] = useState('');
  const gRef = useRef<HTMLDivElement>(null);
  const done = (d: any) => { tokens.setUser(d.token); onAuth(); go('/app'); };
  useEffect(() => { // Connexion Google : bouton officiel chargé seulement si GOOGLE_CLIENT_ID est configuré côté serveur
    if (!cfg?.googleClientId) return;
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => { const g = (window as any).google?.accounts?.id; if (!g || !gRef.current) return;
      g.initialize({ client_id: cfg.googleClientId, callback: (r: any) => a.run(async () => done(await api('/api/auth/google', { body: { credential: r.credential } }))) });
      g.renderButton(gRef.current, { theme: 'outline', size: 'large', locale: 'fr', width: 300 }); };
    document.head.appendChild(s); return () => { s.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.googleClientId]);
  const [appleReady, setAppleReady] = useState(false);
  useEffect(() => { // Connexion Apple : script officiel chargé seulement si APPLE_CLIENT_ID est configuré côté serveur
    if (!cfg?.appleClientId) return;
    const s = document.createElement('script'); s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/fr_FR/appleid.auth.js'; s.async = true;
    s.onload = () => setAppleReady(!!(window as any).AppleID);
    document.head.appendChild(s); return () => { s.remove(); };
  }, [cfg?.appleClientId]);
  const apple = () => a.run(async () => {
    const A = (window as any).AppleID; if (!A) throw new Error('Connexion Apple indisponible pour le moment.');
    const nonce = crypto.randomUUID();
    A.auth.init({ clientId: cfg.appleClientId, scope: 'name email', redirectURI: location.origin, usePopup: true, nonce });
    let r: any; try { r = await A.auth.signIn(); } catch { throw new Error('Connexion Apple annulée.'); }
    done(await api('/api/auth/apple', { body: { idToken: r.authorization.id_token, nonce } }));
  });
  const submit = (e: React.FormEvent) => { e.preventDefault(); a.run(async () => done(await api('/api/auth/login', { body: { email, password } }))); };
  const sendCode = (e: React.FormEvent) => { e.preventDefault(); a.run(async () => { await api('/api/auth/code/request', { body: { email } }); setCodeSent(true); }); };
  const verify = (e: React.FormEvent) => { e.preventDefault(); a.run(async () => done(await api('/api/auth/code/verify', { body: { email, code } }))); };
  return (
    <AuthShell title="Connexion">
      {mode === 'password' ? (
        <form onSubmit={submit}>
          <Field label="Adresse email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Mot de passe"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {a.error && <Alert kind="err">{a.error}</Alert>}
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy}>Se connecter</button><a href="#/mot-de-passe-oublie">Mot de passe oublié ?</a></div>
        </form>
      ) : !codeSent ? (
        <form onSubmit={sendCode}>
          <p className="muted">Nous vous envoyons un code à 6 chiffres par email. Aucun mot de passe nécessaire.</p>
          <Field label="Adresse email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {a.error && <Alert kind="err">{a.error}</Alert>}
          <button className="btn primary" disabled={a.busy}>Recevoir le code</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <Alert kind="ok">Si cette adresse est valide, un code vient d'être envoyé. Il expire dans 10 minutes.</Alert>
          <Field label="Code reçu par email"><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          {a.error && <Alert kind="err">{a.error}</Alert>}
          <div className="row"><button className="btn primary" disabled={a.busy}>Valider</button><button type="button" className="btn sm" onClick={() => { setCodeSent(false); setCode(''); }}>Changer d'adresse</button></div>
        </form>
      )}
      <div className="stack" style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={() => { setMode(mode === 'password' ? 'code' : 'password'); setCodeSent(false); a.run(async () => undefined); }}>{mode === 'password' ? 'Se connecter par code email' : 'Se connecter avec un mot de passe'}</button>
        {cfg?.googleClientId && <div><div ref={gRef} /></div>}
        {cfg?.appleClientId && <button type="button" className="btn" disabled={!appleReady || a.busy} onClick={apple}> Continuer avec Apple</button>}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>Pas encore de compte ? <a href="#/inscription">Créer un compte</a></p>
    </AuthShell>
  );
}

export function Register({ cfg, onAuth }: { cfg: any; onAuth: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [country, setCountry] = useState(''); const a = useAction();
  const [extra, setExtra] = useState(false); const [adult, setAdult] = useState(false);
  const submit = (e: React.FormEvent) => { e.preventDefault(); a.run(async () => {
    const r = await api('/api/auth/register', { body: { email, password, country: country || undefined } });
    setExtra(!!r.needsExtraVerification);
    const d = await api('/api/auth/login', { body: { email, password } }); tokens.setUser(d.token); onAuth(); go('/app'); }); };
  return (
    <AuthShell title="Créer un compte">
      <form onSubmit={submit}>
        <Field label="Adresse email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Mot de passe" hint="10 caractères minimum, avec lettres et chiffres."><input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Pays"><select value={country} onChange={(e) => setCountry(e.target.value)}><option value="">Choisir plus tard</option>{(cfg?.countries ?? []).map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
        <label className="row" style={{ alignItems: 'flex-start', gap: 8, fontWeight: 400 }}><input type="checkbox" required checked={adult} onChange={(e) => setAdult(e.target.checked)} style={{ marginTop: 3 }} /><span className="tiny">Je certifie avoir au moins 18 ans. Velyra AI n'est pas destiné aux mineurs — <a href="#/conformite">détails</a>.</span></label>
        {a.error && <Alert kind="err">{a.error}</Alert>}
        {extra && <Alert kind="warn">Pour protéger la plateforme, une vérification supplémentaire par SMS vous sera demandée.</Alert>}
        <button className="btn primary" disabled={a.busy || !adult} style={{ marginTop: 12 }}>Créer mon compte</button>
      </form>
      <p className="tiny" style={{ marginTop: 14 }}>Un code de confirmation sera envoyé à votre adresse email. Vos données ne sont utilisées que pour faire fonctionner le service ; vous pouvez les exporter ou supprimer votre compte à tout moment (<a href="#/conformite">centre de conformité</a>).</p>
      <p className="muted">Déjà inscrit ? <a href="#/connexion">Se connecter</a></p>
    </AuthShell>
  );
}

export function Forgot() {
  const [step, setStep] = useState(1); const [email, setEmail] = useState(''); const [code, setCode] = useState(''); const [pw, setPw] = useState(''); const a = useAction();
  return (
    <AuthShell title="Mot de passe oublié">
      {step === 1 ? (
        <form onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/auth/forgot', { body: { email } }); setStep(2); }); }}>
          <Field label="Adresse email du compte"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {a.error && <Alert kind="err">{a.error}</Alert>}<button className="btn primary" disabled={a.busy}>Recevoir un code</button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/api/auth/reset', { body: { email, code, newPassword: pw } }); setStep(3); }); }}>
          <p className="muted">Si un compte existe pour {email}, un code à 6 chiffres vient d'être envoyé.</p>
          <Field label="Code reçu"><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Nouveau mot de passe"><input type="password" autoComplete="new-password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          {step === 2 && a.error && <Alert kind="err">{a.error}</Alert>}<button className="btn primary" disabled={a.busy}>Changer le mot de passe</button>
        </form>
      )}
      {step === 3 && <Alert kind="ok">Mot de passe modifié. <a href="#/connexion">Se connecter</a></Alert>}
    </AuthShell>
  );
}

export { msg };

export function Legal({ page }: { page: 'confidentialite' | 'conditions' }) {
  return (
    <div className="wrap" style={{ maxWidth: 760, paddingTop: 24, paddingBottom: 60 }}>
      <p className="tiny"><a href="#/conformite">Voir aussi le centre de conformité complet</a> (remboursement, cookies, audit des outils tiers, accessibilité, protection des mineurs…).</p>
      <Alert kind="warn">Texte provisoire : à faire relire et compléter par un juriste (identité de l'éditeur, durées de conservation, droits applicables en Côte d'Ivoire et ailleurs) avant l'ouverture au public.</Alert>
      {page === 'confidentialite' ? (<div className="stack"><h1>Politique de confidentialité</h1>
        <h3>Données que nous traitons</h3><p>Adresse email, téléphone (pour la confirmation), pays, journaux de connexion et de sécurité, contenus que vous saisissez (conversations, documents, agents), état de vos paiements. Nous ne stockons jamais vos numéros de carte ni vos codes Mobile Money : ils sont saisis chez nos prestataires de paiement.</p>
        <h3>Prestataires qui reçoivent des données</h3>
        <ul><li><b>OpenAI</b> (et, si configurés, Anthropic ou Mistral) : vos messages et le contexte nécessaire sont envoyés pour produire les réponses de l'assistant.</li>
          <li><b>CinetPay</b> et <b>Stripe</b> : paiement (montant, référence, email).</li><li><b>Resend</b> : envoi des emails ; <b>Twilio</b> : envoi des SMS.</li><li><b>Google</b> et <b>Apple</b> : uniquement si vous choisissez ces modes de connexion.</li>
          <li><b>TikTok, YouTube (Google), Facebook, Instagram et WhatsApp (Meta)</b> : uniquement si vous connectez ces comptes (offre Social). Nous lisons vos statistiques et vos publications récentes, conservons les jetons de connexion chiffrés et pouvons envoyer à OpenAI les chiffres et titres de publications nécessaires pour rédiger vos conseils. Vous pouvez déconnecter un compte à tout moment.</li></ul>
        <h3>Agents d'analyse internes</h3><p>Six agents automatiques analysent chaque jour des statistiques anonymes (sécurité, paiements, technique, croissance). L'un d'eux lit le texte des annonces soumises à la marketplace pour proposer une modération ; il peut transmettre ce texte à OpenAI. Aucun agent ne modifie vos comptes, vos paiements ou vos contenus : un humain décide.</p>
        <h3>Vos droits</h3><p>Vous pouvez demander l'accès, la correction ou la suppression de vos données en écrivant à l'adresse de contact du service.</p></div>)
      : (<div className="stack"><h1>Conditions d'utilisation</h1>
        <p>Velyra AI propose un assistant d'intelligence artificielle, des documents, des agents et des outils d'analyse. Les réponses générées par IA peuvent être inexactes : vérifiez-les avant de vous y fier, surtout pour des sujets médicaux, juridiques ou financiers.</p>
        <p>Les offres sont payées pour une durée donnée, sans renouvellement automatique. L'offre est activée seulement après confirmation du paiement par notre serveur.</p>
        <p>Vous vous engagez à ne pas utiliser le service pour des activités illégales, de l'hameçonnage ou la collecte d'identifiants. Nous pouvons suspendre un compte en cas d'abus.</p>
        <p>L'analyse TikTok repose sur les chiffres que vous fournissez ; aucune audience ni viralité n'est garantie.</p></div>)}
    </div>
  );
}
