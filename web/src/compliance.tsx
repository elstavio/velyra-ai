import { useState } from 'react';
import { Alert, rovingTabsKeyDown } from './ui';

/* ------------------------------------------------------------------------------------------------
 * Centre de conformité, de transparence et de protection des utilisateurs.
 * Règle suivie dans tout ce fichier : n'écrire que ce qui est vérifiable dans le code réel de
 * Velyra AI (voir server/config.ts, server/db/schema.ts, server/services/*). Quand une information
 * dépend d'une décision commerciale ou juridique de l'éditeur (raison sociale, adresse, délai de
 * remboursement précis), le texte le dit explicitement au lieu d'inventer un chiffre ou un statut.
 * ------------------------------------------------------------------------------------------------ */

const SECTIONS: [string, string][] = [
  ['mentions', 'Mentions légales'],
  ['confidentialite', 'Confidentialité'],
  ['conditions', "CGU"],
  ['remboursement', 'Remboursement'],
  ['cookies', 'Cookies & traceurs'],
  ['tiers', 'Outils tiers'],
  ['engagements', 'Nos engagements'],
  ['accessibilite', 'Accessibilité'],
  ['mineurs', 'Protection des mineurs'],
  ['donnees', 'Vos données'],
];

function Provisoire({ children }: { children: React.ReactNode }) {
  return <Alert kind="warn">{children}</Alert>;
}

export function ComplianceCenter({ tab: path }: { tab: string }) {
  // I4 : la section active vient de l'URL ("#/conformite/<clé>"), pas d'un état local — le lien direct et
  // le rechargement de page sont ainsi corrects par construction. Repli sur "mentions" (la première section)
  // si le sous-chemin est absent (ex. lien "Centre de conformité" du pied de page, qui pointe vers
  // #/conformite sans sous-chemin) ou ne correspond à aucune clé connue.
  const sub = path.split('/')[0];
  const tab = SECTIONS.some(([k]) => k === sub) ? sub : 'mentions';
  return (
    <div className="wrap" style={{ maxWidth: 820, paddingTop: 24, paddingBottom: 60 }}>
      <h1>Centre de conformité, de transparence et de protection des utilisateurs</h1>
      <p className="muted">Chaque page ci-dessous décrit ce que Velyra AI fait réellement — pas ce qu'un site type ferait en général. Quand un point dépend encore d'une décision de l'éditeur (raison sociale, délai de remboursement exact), c'est marqué « à compléter » plutôt que présenté comme déjà en place.</p>
      <div className="tabs" role="tablist" aria-label="Sections du centre de conformité" style={{ marginTop: 18 }}>
        {SECTIONS.map(([k, l]) => (
          <a key={k} id={`compliance-tab-${k}`} href={`#/conformite/${k}`} role="tab" aria-selected={tab === k} aria-controls="compliance-panel" tabIndex={tab === k ? 0 : -1} className={tab === k ? 'on' : ''} onKeyDown={rovingTabsKeyDown}>{l}</a>
        ))}
      </div>

      <div role="tabpanel" id="compliance-panel" aria-labelledby={`compliance-tab-${tab}`} tabIndex={0}>
      {tab === 'mentions' && (
        <div className="stack">
          <h2>Mentions légales</h2>
          <Provisoire>Section à compléter par l'éditeur avant toute ouverture au public : raison sociale ou statut (ex. entreprise individuelle), numéro d'enregistrement s'il existe, adresse du siège, nom de l'hébergeur une fois le déploiement choisi. Rien de tout cela n'est inventé ici.</Provisoire>
          <div className="card"><h3>Éditeur</h3><p className="muted">Konan Franck — Abidjan, Côte d'Ivoire. Statut juridique et numéro d'enregistrement : [à compléter par l'éditeur].</p></div>
          <div className="card"><h3>Directeur de la publication</h3><p className="muted">Konan Franck.</p></div>
          <div className="card"><h3>Hébergement</h3><p className="muted">[à compléter une fois l'hébergement de production choisi et connecté — nom, adresse de l'hébergeur].</p></div>
          <div className="card"><h3>Contact</h3><p className="muted">[adresse email de contact à publier ici — distincte de l'adresse technique interne].</p></div>
        </div>
      )}

      {tab === 'confidentialite' && (
        <div className="stack">
          <h2>Politique de confidentialité</h2>
          <Provisoire>Texte provisoire : à faire relire par un juriste (durées de conservation précises, droits applicables) avant l'ouverture au public. Le contenu ci-dessous décrit cependant fidèlement ce que le code du service fait.</Provisoire>
          <h3>Collecte minimale — ce que nous demandons et pourquoi</h3>
          <p>Nous ne demandons que ce qui sert directement à faire fonctionner le service : adresse email et mot de passe (ou connexion Google/Apple), numéro de téléphone (uniquement pour confirmer les essais gratuits — un compte par numéro vérifié), pays (pour afficher les bons moyens de paiement et la bonne devise). Rien d'autre n'est demandé à l'inscription — pas de nom complet, pas d'adresse postale, pas de date de naissance.</p>
          <h3>Données traitées une fois le compte créé</h3>
          <p>Le contenu que vous saisissez vous-même (conversations, mémoires que vous choisissez de garder, documents importés, agents, workflows), l'état de vos paiements et abonnements, les journaux de connexion et de sécurité (adresse IP, appareil) nécessaires pour protéger votre compte. Nous ne stockons jamais vos numéros de carte ni vos codes Mobile Money : ils sont saisis directement chez nos prestataires de paiement.</p>
          <h3>Prestataires qui reçoivent des données</h3>
          <ul>
            <li><b>OpenAI</b> (et, si configurés, Anthropic ou Mistral) : vos messages et le contexte nécessaire, pour produire les réponses de l'assistant.</li>
            <li><b>CinetPay</b> et <b>Stripe</b> : données de paiement (montant, référence, email).</li>
            <li><b>Resend</b> (email) et <b>Twilio</b> (SMS) : pour vous envoyer les codes et notifications.</li>
            <li><b>Google</b> et <b>Apple</b> : uniquement si vous choisissez ces modes de connexion.</li>
            <li><b>TikTok, YouTube (Google), Facebook, Instagram, WhatsApp (Meta)</b> : uniquement si vous connectez ces comptes (offre Réseaux). Jetons de connexion chiffrés, déconnexion possible à tout moment.</li>
          </ul>
          <h3>Agents d'analyse internes</h3>
          <p>Des agents automatiques analysent chaque jour des statistiques anonymes (sécurité, paiements, technique, croissance). Aucun agent ne modifie vos comptes, vos paiements ou vos contenus de sa propre initiative : une décision qui vous affecte reste prise par une personne.</p>
          <h3>Vos droits</h3>
          <p>Accès, export et suppression sont déjà disponibles depuis votre compte (voir l'onglet « Vos données » de ce centre) — ce ne sont pas des promesses, ce sont des boutons qui existent déjà dans Velyra AI.</p>
        </div>
      )}

      {tab === 'conditions' && (
        <div className="stack">
          <h2>Conditions générales d'utilisation</h2>
          <Provisoire>Texte provisoire : à faire relire par un juriste avant l'ouverture au public.</Provisoire>
          <p>Velyra AI propose un assistant d'intelligence artificielle, des documents, des agents et des outils d'analyse. Les réponses générées par IA peuvent être inexactes : vérifiez-les avant de vous y fier, surtout pour des sujets médicaux, juridiques ou financiers.</p>
          <p>Les offres sont payées pour une durée donnée, <b>sans renouvellement automatique</b>. L'offre est activée seulement après confirmation du paiement par notre serveur — jamais avant.</p>
          <p>L'analyse TikTok repose sur les chiffres que vous fournissez ; aucune audience ni viralité n'est garantie.</p>
          <p>Vous vous engagez à ne pas utiliser le service pour des activités illégales, de l'hameçonnage ou la collecte d'identifiants. Un compte peut être suspendu en cas d'abus, jamais sans motif journalisé.</p>
          <h3>Âge minimum</h3>
          <p>Le service est réservé aux personnes d'au moins 18 ans. À l'inscription, vous devez cocher une case certifiant que vous remplissez cette condition (voir l'onglet « Protection des mineurs »).</p>
        </div>
      )}

      {tab === 'remboursement' && (
        <div className="stack">
          <h2>Politique de remboursement</h2>
          <Provisoire>Les délais et conditions exacts ci-dessous sont un point de départ à valider par l'éditeur — le code actuel ne traite que des remboursements internes de jetons (quand une tâche IA échoue techniquement), pas encore des remboursements monétaires automatisés. Une demande de remboursement réel est donc traitée manuellement pour l'instant, pas par un bouton dans l'application.</Provisoire>
          <h3>Ce qui est déjà automatique</h3>
          <p>Si une tâche facturée en jetons échoue pour une raison technique de notre côté, le jeton correspondant vous est recrédité automatiquement — sans démarche de votre part.</p>
          <h3>Ce qui est manuel, pour l'instant</h3>
          <p>Pour un remboursement d'un paiement d'offre (Pro, option TikTok, etc.), écrivez à l'adresse de contact indiquée dans les mentions légales en précisant la référence de paiement (visible dans Compte → Mes paiements). Chaque demande est examinée individuellement : [l'éditeur doit encore fixer et publier ici un délai et des conditions précis — par exemple « remboursable sous 14 jours si le service n'a pas été utilisé »].</p>
          <p className="tiny">Aucune promesse de remboursement automatique n'est affichée ailleurs dans l'application tant que cette politique n'est pas finalisée.</p>
        </div>
      )}

      {tab === 'cookies' && (
        <div className="stack">
          <h2>Cookies et traceurs</h2>
          <Alert kind="ok">Vérifié dans le code source le 13/11/2026 : aucune ligne du serveur ni du site n'écrit de cookie (aucun <code>Set-Cookie</code>, aucun <code>document.cookie</code>). La connexion utilise un jeton stocké uniquement dans le stockage local de votre navigateur (localStorage), jamais transmis à un tiers.</Alert>
          <p>Velyra AI ne dépose aucun cookie de mesure d'audience, aucun cookie publicitaire, aucun traceur tiers caché. Il n'y a donc rien à « accepter » au sens où l'entend la réglementation sur les cookies (pas de traceur non essentiel = pas de bandeau de consentement à cocher).</p>
          <h3>Une nuance honnête</h3>
          <p>Si vous choisissez de vous connecter avec <b>Google</b> ou <b>Apple</b>, ces scripts tiers (chargés uniquement sur l'écran de connexion, et seulement si ce mode est proposé) peuvent déposer leurs propres cookies techniques liés à votre compte Google/Apple, selon leur politique à eux — pas la nôtre. Si vous préférez l'éviter, utilisez la connexion par email et mot de passe (ou par code à usage unique), qui n'implique aucun tiers.</p>
          <h3>Pourquoi un bandeau apparaît quand même</h3>
          <p>Un petit bandeau s'affiche une fois, sur votre premier écran, pour vous dire exactement ce qui précède — pas pour vous demander d'accepter quelque chose dont vous n'avez pas besoin.</p>
        </div>
      )}

      {tab === 'tiers' && (
        <div className="stack">
          <h2>Audit des outils et services tiers</h2>
          <p className="muted">Liste exhaustive des services externes que le code de Velyra AI peut appeler, telle qu'elle existe dans la configuration du serveur — pas une liste marketing.</p>
          <div className="card"><h3>Toujours potentiellement actifs</h3>
            <ul>
              <li><b>Fournisseurs IA</b> — OpenAI, et si une clé est configurée : Anthropic, Mistral. Reçoivent le contenu nécessaire à la génération des réponses.</li>
              <li><b>CinetPay</b> — paiements et retraits Mobile Money (Afrique de l'Ouest/Centrale).</li>
              <li><b>Stripe</b> — cartes, Apple Pay, Google Pay, prélèvement SEPA (si une clé est configurée).</li>
            </ul></div>
          <div className="card"><h3>Actifs seulement si configurés</h3>
            <ul>
              <li><b>Resend</b> (email) et <b>Twilio</b> (SMS) — sinon les messages restent en mode démonstration (aucun envoi réel).</li>
              <li><b>Google</b> et <b>Apple</b> — uniquement si vous utilisez ces connexions.</li>
              <li><b>TikTok, YouTube (Google), Meta (Facebook/Instagram/WhatsApp)</b> — uniquement si vous connectez un compte dans l'offre Réseaux.</li>
            </ul></div>
          <div className="card"><h3>Infrastructure</h3><p className="muted">Base de données et hébergement de production : [à publier ici une fois le déploiement finalisé — voir Mentions légales].</p></div>
        </div>
      )}

      {tab === 'engagements' && (
        <div className="stack">
          <h2>Nos engagements</h2>
          <p className="muted">Chaque engagement ci-dessous est accompagné de ce qui a réellement été vérifié dans le produit, pas d'une simple affirmation.</p>
          <div className="card"><h3>Zéro piège</h3><p className="muted">Aucune case précochée, aucun bouton d'annulation caché : l'abonnement n'a pas de renouvellement automatique (donc rien à « annuler en vitesse »), et la suppression de compte est un vrai bouton dans Compte, pas un parcours caché derrière un support à contacter.</p></div>
          <div className="card"><h3>Zéro frais caché</h3><p className="muted">Le prix affiché dans votre devise avant paiement est le prix final ; il n'y a pas de frais ajoutés à l'étape de paiement.</p></div>
          <div className="card"><h3>Zéro faux avis</h3><p className="muted">Vérifié dans le code source : aucun témoignage, note ou avis client n'est affiché nulle part dans l'application — ni vrai ni inventé. S'il y en a un jour, ce seront de vrais avis attribuables.</p></div>
          <div className="card"><h3>Zéro promesse non prouvée</h3><p className="muted">La page d'accueil dit explicitement « aucune promesse de viralité » pour l'analyse TikTok, et les CGU rappellent que les réponses de l'IA peuvent être inexactes. Aucun chiffre de performance n'est avancé sans donnée réelle derrière.</p></div>
        </div>
      )}

      {tab === 'accessibilite' && (
        <div className="stack">
          <h2>Accessibilité</h2>
          <p className="muted">Points vérifiés techniquement le 13/11/2026, pas une simple déclaration d'intention :</p>
          <div className="card"><h3>Contraste des couleurs</h3><p className="muted">Les paires texte/fond du thème clair et du thème sombre ont été mesurées (formule WCAG). Un texte secondaire sous le seuil recommandé (3,0:1) a été corrigé à 4,5:1 en clair comme en sombre ; le reste du texte dépasse déjà largement ce seuil (6:1 à 18:1 selon les cas).</p></div>
          <div className="card"><h3>Navigation au clavier</h3><p className="muted">Un indicateur de focus visible (liseré doré) s'affiche sur tout élément interactif au clavier, dans toute l'application. Le seul contrôle personnalisé non natif (choix du moyen de paiement) a les rôles ARIA et la prise en charge clavier (flèches/Entrée/Espace) d'un vrai bouton radio.</p></div>
          <div className="card"><h3>Texte alternatif des images</h3><p className="muted">L'interface de Velyra AI est construite en HTML/CSS natif plutôt qu'en images : elle ne contient aucune image de contenu nécessitant un texte alternatif (seules des icônes d'application existent, hors du contenu lu par les utilisateurs).</p></div>
        </div>
      )}

      {tab === 'mineurs' && (
        <div className="stack">
          <h2>Protection des mineurs</h2>
          <p>Velyra AI est réservé aux personnes d'au moins 18 ans. À l'inscription, une case à cocher demande de certifier cet âge minimum ; aucun compte n'est créé sans cette confirmation.</p>
          <Provisoire>Honnêteté sur la limite : il s'agit d'une auto-certification, comme sur l'immense majorité des services en ligne — il n'existe pas de vérification d'identité ou d'âge officielle derrière cette case. Un contrôle parental technique (compte supervisé, accord vérifié d'un parent) n'est pas construit à ce jour ; cette section sera mise à jour si l'éditeur décide d'en ajouter un.</Provisoire>
          <p className="muted">Un compte visiblement utilisé par un mineur peut être suspendu dès que c'est porté à notre connaissance.</p>
        </div>
      )}

      {tab === 'donnees' && (
        <div className="stack">
          <h2>Vos données : export et suppression</h2>
          <p>Ces deux droits ne sont pas de simples promesses : ce sont des fonctions déjà actives dans l'application, accessibles depuis <a href="#/app/compte">Compte</a> une fois connecté.</p>
          <div className="card"><h3>Exporter mes données</h3><p className="muted">Un bouton « Exporter mes données » télécharge un fichier reprenant les informations liées à votre compte.</p></div>
          <div className="card"><h3>Supprimer mon compte</h3><p className="muted">Un bouton « Supprimer mon compte » efface vos conversations, souvenirs, documents et agents après confirmation (mot de passe ou code reçu par email). Les écritures de paiement peuvent être conservées, sans lien avec votre identité, pour des raisons comptables légales.</p></div>
          <h3>Droits sur les polices et visuels utilisés</h3>
          <p className="muted">La police Inter (et Space Grotesk pour les titres) est chargée depuis Google Fonts, sous licence libre (SIL Open Font License), dans les conditions d'usage prévues pour le web. Aucune image, photo ou illustration de banque d'images n'est utilisée dans l'application : l'interface est dessinée en CSS, pas en images importées.</p>
        </div>
      )}
      </div>
    </div>
  );
}

const SEEN_KEY = 'vly_transparency_seen';
export function TransparencyBanner() {
  const [dismissed, setDismissed] = useState<boolean>(() => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } });
  if (dismissed) return null;
  const close = () => { setDismissed(true); try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* stockage indisponible : réapparaîtra, sans gravité */ } };
  return (
    <div className="card flat" role="note" style={{ margin: '0 auto 14px', maxWidth: 1040, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <p className="tiny" style={{ margin: 0, flex: 1 }}>Velyra AI ne dépose aucun cookie de suivi ni traceur publicitaire — seule une connexion Google ou Apple, si vous la choisissez, peut en déposer un de son côté. <a href="#/conformite">Détails dans le centre de conformité</a>.</p>
      <button type="button" className="btn sm" onClick={close}>Compris</button>
    </div>
  );
}
