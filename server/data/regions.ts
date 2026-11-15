export type Region = 'west_africa' | 'central_africa' | 'east_africa' | 'europe' | 'other';
import { config } from '../config.js';
export interface Country { name: string; region: Region; currency: 'XOF' | 'XAF' | 'CDF' | 'GNF' | 'USD' | 'EUR' }

/** Stripe actif : Europe facturée en euros (CinetPay n'accepte pas l'EUR). */
export const stripeOn = () => !!config.stripe.secretKey;
export const currencyOf = (c: Country): Country['currency'] => (c.region === 'europe' && stripeOn() ? 'EUR' : c.currency);
export const STRIPE_ONLY_METHODS = ['sepa', 'apple_pay', 'google_pay'];

const mk = (region: Region, currency: Country['currency'], entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([c, name]) => [c, { name, region, currency } as Country]));

// Devises acceptées par CinetPay : XOF, XAF, CDF, GNF, USD (doc « Initialisation du paiement »).
export const COUNTRIES: Record<string, Country> = {
  ...mk('west_africa', 'XOF', { CI: "Côte d'Ivoire", SN: 'Sénégal', ML: 'Mali', BF: 'Burkina Faso', NE: 'Niger', TG: 'Togo', BJ: 'Bénin', GW: 'Guinée-Bissau' }),
  ...mk('west_africa', 'GNF', { GN: 'Guinée' }),
  ...mk('west_africa', 'USD', { GH: 'Ghana', NG: 'Nigeria', LR: 'Libéria', SL: 'Sierra Leone', GM: 'Gambie', CV: 'Cap-Vert', MR: 'Mauritanie' }),
  ...mk('central_africa', 'XAF', { CM: 'Cameroun', GA: 'Gabon', CG: 'Congo-Brazzaville', TD: 'Tchad', CF: 'Centrafrique', GQ: 'Guinée équatoriale' }),
  ...mk('central_africa', 'CDF', { CD: 'RD Congo' }),
  ...mk('central_africa', 'USD', { AO: 'Angola', ST: 'Sao Tomé-et-Principe' }),
  ...mk('east_africa', 'USD', { KE: 'Kenya', TZ: 'Tanzanie', UG: 'Ouganda', RW: 'Rwanda', BI: 'Burundi', ET: 'Éthiopie', SS: 'Soudan du Sud', SO: 'Somalie', DJ: 'Djibouti', ER: 'Érythrée', MG: 'Madagascar', MW: 'Malawi', MZ: 'Mozambique', ZM: 'Zambie', ZW: 'Zimbabwe', MU: 'Maurice', SC: 'Seychelles', KM: 'Comores' }),
  ...mk('europe', 'USD', {
    FR: 'France', BE: 'Belgique', CH: 'Suisse', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', PT: 'Portugal', NL: 'Pays-Bas', LU: 'Luxembourg', GB: 'Royaume-Uni', IE: 'Irlande',
    AT: 'Autriche', SE: 'Suède', NO: 'Norvège', DK: 'Danemark', FI: 'Finlande', PL: 'Pologne', CZ: 'Tchéquie', GR: 'Grèce', RO: 'Roumanie', HU: 'Hongrie', BG: 'Bulgarie',
    HR: 'Croatie', SK: 'Slovaquie', SI: 'Slovénie', LT: 'Lituanie', LV: 'Lettonie', EE: 'Estonie', CY: 'Chypre', MT: 'Malte', IS: 'Islande', LI: 'Liechtenstein',
  }),
  // Hors des quatre régions du cahier des charges : paiement par carte uniquement.
  ...mk('other', 'USD', { MA: 'Maroc', DZ: 'Algérie', TN: 'Tunisie', EG: 'Égypte', ZA: 'Afrique du Sud', US: 'États-Unis', CA: 'Canada', BR: 'Brésil', IN: 'Inde', CN: 'Chine', AE: 'Émirats arabes unis', OTHER: 'Autre pays' }),
};

export type Method = 'wave' | 'mtn' | 'orange' | 'moov' | 'card' | 'apple_pay' | 'google_pay' | 'sepa';
export interface MethodInfo { id: Method; label: string; available: boolean; note?: string }

/** Moyens proposés par région (§3). Les moyens non pris en charge par l'agrégateur sont listés « indisponibles » et non cachés. */
export function methodsFor(region: Region, stripe = stripeOn()): MethodInfo[] {
  if (region === 'west_africa') {
    return [
      { id: 'wave', label: 'Wave', available: true }, { id: 'mtn', label: 'MTN Mobile Money', available: true },
      { id: 'orange', label: 'Orange Money', available: true }, { id: 'moov', label: 'Moov Money', available: true },
      { id: 'card', label: 'Carte bancaire', available: true },
    ];
  }
  const m: MethodInfo[] = [{ id: 'card', label: 'Carte bancaire', available: true }];
  if (region === 'europe') {
    const na = 'Disponible dès que Stripe est configuré sur le serveur (STRIPE_SECRET_KEY).';
    m.push({ id: 'sepa', label: 'Prélèvement SEPA', available: stripe, note: stripe ? undefined : na },
      { id: 'apple_pay', label: 'Apple Pay', available: stripe, note: stripe ? 'Affiché par Stripe sur les appareils et navigateurs compatibles.' : na },
      { id: 'google_pay', label: 'Google Pay', available: stripe, note: stripe ? 'Affiché par Stripe sur les appareils et navigateurs compatibles.' : na });
  }
  return m;
}

export const MOBILE_METHODS: Method[] = ['wave', 'mtn', 'orange', 'moov'];
export const countryList = () => Object.entries(COUNTRIES).map(([code, c]) => ({ code, ...c })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
export const PHONE_PREFIX: Record<string, string> = { CI: '225', SN: '221', ML: '223', BF: '226', NE: '227', TG: '228', BJ: '229', GW: '245', GN: '224', GH: '233', NG: '234', CM: '237', GA: '241', CG: '242', CD: '243', TD: '235', CF: '236' };
