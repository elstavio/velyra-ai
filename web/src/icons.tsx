/**
 * M4 : bibliothèque SVG centralisée — harmonise les icônes de la navigation principale, de l'administration
 * et des plateformes sociales (jusqu'ici des glyphes Unicode dépendant de la police système, cf. l'audit M4),
 * et centralise IconChat/IconTrend/IconDocs/IconArrow (auparavant définies localement dans app1.tsx, seules
 * icônes SVG existantes de l'application — elles servent ici de référence de style, reprise à l'identique).
 *
 * Convention commune à TOUTES les icônes FONCTIONNELLES (pas les logos de marque, voir plus bas) :
 *  - viewBox="0 0 20 20" (même grille que les 4 icônes d'origine, aucun redimensionnement nécessaire) ;
 *  - fill="none" stroke="currentColor" strokeWidth={1.6} (hérite nativement de la couleur du texte
 *    environnant — tokens --ink-2/--ink/--gold déjà en place — donc compatible thème clair/sombre par
 *    construction, sans dupliquer un seul SVG) ;
 *  - strokeLinecap="round" strokeLinejoin="round" (extrémités et angles arrondis, cohérence du trait) ;
 *  - aucune dimension (width/height) posée sur le <svg> lui-même : la taille de rendu est entièrement
 *    pilotée par le CSS du contexte d'affichage (styles.css), exactement comme IconChat/IconTrend/IconDocs
 *    le faisaient déjà — IconArrow, seule exception avant M4 (taille posée en JSX), est alignée ici sur la
 *    même convention (voir plus bas).
 *  - aucune dépendance externe : composants fonctionnels purs, comme l'existant.
 *
 * Les LOGOS de plateformes sociales dérogent volontairement à "stroke/currentColor" : ce sont des marques
 * déposées, dont la reconnaissance immédiate dépend aussi de leurs couleurs officielles (mandat M4, point 4).
 * Chacun est un badge AUTO-CONTRASTÉ (sa propre forme colorée pleine, pas la couleur du texte environnant),
 * donc lisible aussi bien sur fond de carte clair (--surface clair) que sombre (--surface sombre) sans aucune
 * variante par thème à maintenir — à la seule exception de TikTok (voir son commentaire dédié ci-dessous),
 * dont la pratique de marque officielle elle-même prévoit un tracé qui s'inverse selon le fond.
 */
import { useId } from 'react';

export type IconCmp = () => JSX.Element;

/* ------------------------------------------------------------------ Navigation principale (app) */

export function IconHome() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 9.6 10 3.6l6.8 6" />
      <path d="M5.1 8.2v7.2a1 1 0 0 0 1 1h2.9v-4.9h2v4.9h2.9a1 1 0 0 0 1-1V8.2" />
    </svg>
  );
}

export function IconChat() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5.5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4.5A1.5 1.5 0 0 1 3 11.5v-6Z" />
    </svg>
  );
}

// « Mémoire » : icône de repère/marque-page (ce que l'assistant retient d'une conversation à l'autre),
// silhouette volontairement distincte de la bulle de dialogue (IconChat) et du document (IconDocs).
export function IconMemory() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.6 3.6h8.8a1 1 0 0 1 1 1V17l-5.4-3.3L4.6 17V4.6a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

export function IconDocs() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2.5h5.5L15 6v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
      <path d="M11.5 2.5V6H15" />
      <path d="M7.5 10.5h5M7.5 13h5" />
    </svg>
  );
}

// « Agents » (app, bibliothèque d'assistants personnalisés) : silhouette d'assistant/robot — volontairement
// distincte d'IconAgentsAI (admin, « Agents IA » internes, traité en puce électronique plus bas), même si les
// deux évoquent l'idée d'IA : les deux concepts sont sans rapport (bibliothèque d'agents personnels de
// l'utilisateur vs les 6 agents internes qui font tourner la plateforme).
export function IconAgents() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="11.3" r="5.1" />
      <path d="M10 6.2V3.8" />
      <circle cx="10" cy="3.1" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7.9" cy="11.3" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="12.1" cy="11.3" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconWorkflow() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.3" cy="5" r="1.6" />
      <circle cx="4.3" cy="15" r="1.6" />
      <circle cx="15.7" cy="10" r="1.6" />
      <path d="M5.8 5.7 14.2 9.4M5.8 14.3l8.4-4" />
    </svg>
  );
}

// Partagée nav app (« Marketplace ») et admin (modération des annonces) — même concept, un seul dessin.
export function IconMarketplace() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 7 4.6 3.4h10.8L16.5 7" />
      <path d="M3.5 7h13v1.3a2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1-2 2 2 2 0 0 1-2-2V7Z" />
      <path d="M5 10.3V16.4h10V10.3" />
    </svg>
  );
}

// Partagée nav app (« Réseaux ») et admin (« Réseaux »).
export function IconNetwork() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="4.3" r="1.7" />
      <circle cx="4.3" cy="15" r="1.7" />
      <circle cx="15.7" cy="15" r="1.7" />
      <path d="M8.8 5.9 5.6 13.3M11.2 5.9l3.2 7.4M6.3 15h7.4" />
    </svg>
  );
}

// Partagée nav app (« Offres ») et admin (« Offres et prix »).
export function IconOffers() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.7 3.4h4.3a1 1 0 0 1 1 1v4.3a1 1 0 0 1-.3.7l-7.6 7.6a1 1 0 0 1-1.4 0l-4.7-4.7a1 1 0 0 1 0-1.4l7.6-7.6a1 1 0 0 1 .5-.9Z" />
      <circle cx="13.1" cy="6.9" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconApi() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.2 6 3.2 10l4 4" />
      <path d="M12.8 6l4 4-4 4" />
    </svg>
  );
}

export function IconAccount() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="6.9" r="3" />
      <path d="M3.7 16.6a6.3 6.3 0 0 1 12.6 0" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Administration */

export function IconOverview() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.4" y="3.4" width="5.6" height="5.6" rx="1.2" />
      <rect x="11" y="3.4" width="5.6" height="5.6" rx="1.2" />
      <rect x="3.4" y="11" width="5.6" height="5.6" rx="1.2" />
      <rect x="11" y="11" width="5.6" height="5.6" rx="1.2" />
    </svg>
  );
}

// « Utilisateurs » (admin, groupe/population) — distincte d'IconAccount (nav, une seule personne : « mon
// compte ») et d'IconAgents (nav, assistant personnel).
export function IconUsers() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.1" cy="7.2" r="2.3" />
      <circle cx="14" cy="8.1" r="1.9" />
      <path d="M2.8 16.3a4.4 4.4 0 0 1 8.6 0" />
      <path d="M11.8 16.3a3.6 3.6 0 0 1 5.9-2.8" />
    </svg>
  );
}

// « Paiements » (admin, cartes/transactions) — distincte d'IconOffers (étiquette de prix) et d'IconWallet
// (portefeuille/virements).
export function IconPayments() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.8" y="5" width="14.4" height="10" rx="1.6" />
      <path d="M2.8 8.3h14.4" />
      <path d="M5.2 12h3.2" />
    </svg>
  );
}

export function IconWallet() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6.2a1.7 1.7 0 0 1 1.7-1.7h9.6A1.7 1.7 0 0 1 16 6.2v8.1a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V6.2Z" />
      <path d="M13 10.3h2.5a1 1 0 0 1 1 1v1.4a1 1 0 0 1-1 1H13a1.7 1.7 0 0 1 0-3.4Z" />
    </svg>
  );
}

export function IconFraud() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3.4 17.2 16a1 1 0 0 1-.9 1.5H3.7a1 1 0 0 1-.9-1.5L10 3.4Z" />
      <path d="M10 8.1v3.6" />
      <circle cx="10" cy="14.1" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconSecurity() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2.9 16.1 5.2v4.3c0 4-2.5 6.9-6.1 8.4-3.6-1.5-6.1-4.4-6.1-8.4V5.2L10 2.9Z" />
      <path d="M7.3 10l1.9 1.9 3.5-3.9" />
    </svg>
  );
}

// « Contrôles » (audit automatique d'intégrité des données, rejoué périodiquement) : représenté par un
// cadran/jauge de supervision — distinct d'IconSecurity (bouclier) et d'IconFraud (alerte triangulaire).
export function IconControls() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.6 13.6a6.4 6.4 0 0 1 12.8 0" />
      <path d="M10 13.6 13.1 9" />
      <circle cx="10" cy="13.6" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// « Agents IA » (admin, les 6 agents internes qui font tourner la plateforme) : puce électronique — distincte
// d'IconAgents (nav, assistant personnel de l'utilisateur).
export function IconAgentsAI() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="8" height="8" rx="1.4" />
      <path d="M10 3.3V6M10 14v2.7M3.3 10H6M14 10h2.7M6.3 6.3 4.7 4.7M15.3 15.3l-1.6-1.6M6.3 13.7l-1.6 1.6M15.3 4.7l-1.6 1.6" />
    </svg>
  );
}

// « Finances » (admin, vue agrégée des encaissements) : histogramme — distincte d'IconPayments (carte) et
// d'IconDocs (document).
export function IconFinances() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 16.3V5" />
      <path d="M3.5 16.3h13" />
      <path d="M6.2 13.4V9.6M9.6 13.4V7.7M13 13.4V5.9M16.4 13.4v-2.6" />
    </svg>
  );
}

export function IconTokens() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="10" cy="6" rx="5.3" ry="2.3" />
      <path d="M4.7 6v8c0 1.27 2.37 2.3 5.3 2.3s5.3-1.03 5.3-2.3V6" />
      <path d="M4.7 10c0 1.27 2.37 2.3 5.3 2.3s5.3-1.03 5.3-2.3" />
    </svg>
  );
}

// « Analyses IA » (admin, synthèses statistiques automatiques) : étincelle + tendance — distincte d'IconTrend
// (raccourci du tableau de bord, une simple flèche montante) et d'IconFinances (histogramme).
export function IconInsights() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.2 3.5c.4 2 1.7 3.3 3.7 3.7-2 .4-3.3 1.7-3.7 3.7-.4-2-1.7-3.3-3.7-3.7 2-.4 3.3-1.7 3.7-3.7Z" />
      <path d="M4 13.7 7.9 16.5l3-2.7 4.9 3" />
    </svg>
  );
}

export function IconSystem() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 3.6v2M10 14.4v2M16.4 10h-2M5.6 10h-2M14.5 5.5l-1.4 1.4M6.9 13.1l-1.4 1.4M14.5 14.5l-1.4-1.4M6.9 6.9 5.5 5.5" />
    </svg>
  );
}

// Repli générique (équivalent du '•' qu'ADMIN_ICON utilisait déjà comme valeur par défaut, en pratique jamais
// atteinte puisque les 15 clés de TABS ont toutes une icône dédiée ci-dessus — conservé par prudence).
export function IconDot() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" stroke="none">
      <circle cx="10" cy="10" r="3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Chevron (bouton du menu mobile admin) */

export function IconChevronDown() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Tableau de bord (app1.tsx) */
// Reprises à l'identique (même tracé, même grille) ; seule IconArrow change : strokeWidth alignée à 1.6
// (était 1.8, seule incohérence relevée dans l'audit M4) et les attributs width/height={15} posés en JSX
// sont retirés — sa taille est désormais pilotée par la même règle CSS que les 3 autres (.action-card .go
// svg, nouvelle règle dans styles.css), au lieu d'être la seule à déroger à la convention commune.

export function IconTrend() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 15.5 8 9l3.2 3.2L17 5" />
      <path d="M12.5 5H17v4.5" />
    </svg>
  );
}

export function IconArrow() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 15 15 5M8 5h7v7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Logos des plateformes sociales */
// Chaque logo est un badge AUTO-CONTRASTÉ (forme pleine à ses propres couleurs officielles), lisible sur
// n'importe quel fond de carte — clair ou sombre — sans variante par thème : la couleur du badge, pas celle
// du texte environnant, assure le contraste. Silhouettes simplifiées mais fidèles aux marques réelles,
// jamais remplacées par des symboles génériques (exigence explicite du mandat).

export function LogoYouTube() {
  return (
    <svg viewBox="0 0 20 20">
      <rect x="2" y="5" width="16" height="10" rx="3" fill="#FF0000" />
      <path d="M8.2 7.8v4.4l4-2.2-4-2.2Z" fill="#fff" />
    </svg>
  );
}

export function LogoFacebook() {
  return (
    <svg viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" fill="#1877F2" />
      <path d="M11.3 16.5V10.6h2l.3-2.3h-2.3V6.8c0-.67.2-1.1 1.14-1.1h1.2V3.6a16 16 0 0 0-1.76-.1c-1.74 0-2.94 1.06-2.94 3v1.7H7.1v2.3h1.84v5.9h2.36Z" fill="#fff" />
    </svg>
  );
}

export function LogoWhatsApp() {
  return (
    <svg viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" fill="#25D366" />
      <path d="M13.9 11.2c-.2-.1-1.3-.6-1.5-.7-.2-.1-.35-.1-.5.1-.15.2-.55.7-.68.83-.13.14-.25.15-.46.05-.21-.1-.9-.33-1.7-1.05-.63-.56-1.05-1.26-1.17-1.47-.12-.21-.01-.33.09-.43.1-.1.21-.25.32-.37.1-.13.14-.22.2-.37.07-.15.03-.28-.02-.39-.05-.1-.5-1.2-.68-1.64-.18-.43-.36-.37-.5-.38h-.43c-.15 0-.39.06-.59.28-.2.21-.78.76-.78 1.86s.8 2.16.91 2.31c.11.15 1.57 2.4 3.8 3.36.53.23.94.37 1.27.47.53.17 1.02.14 1.4.09.43-.07 1.3-.53 1.48-1.04.18-.5.18-.94.13-1.03-.05-.1-.2-.16-.42-.27Z" fill="#fff" />
    </svg>
  );
}

// Carré arrondi au dégradé officiel (jaune → orange → rose → violet → bleu), glyphe « appareil photo »
// (cadre arrondi + objectif + déclencheur) en blanc par-dessus. useId() évite toute collision d'identifiant
// de dégradé si plusieurs instances de ce logo venaient à être rendues simultanément sur la même page.
export function LogoInstagram() {
  const gid = `ig-grad-${useId()}`;
  return (
    <svg viewBox="0 0 20 20">
      <defs>
        <linearGradient id={gid} x1="0" y1="20" x2="20" y2="0">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset=".25" stopColor="#FA7E1E" />
          <stop offset=".5" stopColor="#D62976" />
          <stop offset=".75" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="16" height="16" rx="5" fill={`url(#${gid})`} />
      <rect x="6.2" y="6.2" width="7.6" height="7.6" rx="2.6" fill="none" stroke="#fff" strokeWidth={1.5} />
      <circle cx="10" cy="10" r="2.1" fill="none" stroke="#fff" strokeWidth={1.5} />
      <circle cx="14" cy="6" r="0.9" fill="#fff" />
    </svg>
  );
}

// TikTok : seule exception à la règle « badge auto-contrasté ci-dessus », et c'est la pratique officielle de
// la marque elle-même qui l'impose : TikTok fournit un tracé noir pour fond clair et un tracé blanc pour
// fond sombre (pas de badge de couleur unique qui fonctionnerait sur les deux). Le tracé principal utilise
// donc currentColor (il s'inverse automatiquement clair/sombre avec le texte environnant, exactement comme
// le recommande TikTok), tandis que les deux silhouettes décalées cyan/magenta qui créent l'effet de
// superposition signature de la marque restent des couleurs de marque fixes (suffisamment vives pour rester
// visibles sur les deux thèmes).
export function LogoTikTok() {
  const d = 'M12.6 3.6v7.6a3.4 3.4 0 1 1-2.1-3.1V3.6h2.1Z';
  return (
    <svg viewBox="0 0 20 20">
      <path d={d} fill="#25F4EE" transform="translate(-0.7,-0.7)" />
      <path d={d} fill="#FE2C55" transform="translate(0.7,0.7)" />
      <path d={d} fill="currentColor" />
    </svg>
  );
}
