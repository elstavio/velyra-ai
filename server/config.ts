import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const env = process.env;
const num = (k: string, d: number) => {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variable ${k} invalide : nombre attendu`);
  return n;
};
const str = (k: string, d = '') => env[k] ?? d;
const bool = (k: string, d = false) => (env[k] === undefined ? d : ['1', 'true', 'yes', 'oui'].includes(env[k]!.toLowerCase()));

export const isProd = str('NODE_ENV') === 'production';
export const isTest = str('NODE_ENV') === 'test';
const root = resolve(str('DATA_DIR', './data'));

/** Clé de chiffrement AES-256 (32 octets, base64). Obligatoire en production. */
function loadEncryptionKey(): Buffer {
  const v = env.ENCRYPTION_KEY;
  if (v) {
    const b = Buffer.from(v, 'base64');
    if (b.length !== 32) throw new Error('ENCRYPTION_KEY doit être 32 octets encodés en base64 (openssl rand -base64 32)');
    return b;
  }
  if (isProd) throw new Error('ENCRYPTION_KEY est obligatoire en production');
  // Développement uniquement : clé locale générée une fois, jamais commitée (dossier data/ ignoré par git).
  const p = resolve(root, '.devkey');
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
}

const appUrlResolved = str('APP_URL', `http://localhost:${num('PORT', 3000)}`).replace(/\/$/, '');

export const config = {
  isProd,
  port: num('PORT', 3000),
  appUrl: appUrlResolved,
  /** RP ID WebAuthn (passkeys) : le nom d'hôte seul, sans schéma ni port — dérivé d'APP_URL. */
  webauthnRpId: new URL(appUrlResolved).hostname,
  dataDir: root,
  databaseUrl: str('DATABASE_URL'),
  sqlitePath: str('SQLITE_PATH', resolve(root, 'velyra.db')),
  encryptionKey: loadEncryptionKey(),
  trustProxyHops: num('TRUST_PROXY_HOPS', isProd ? 1 : 0),
  /** Origine autorisée si le frontend est hébergé séparément (ex. Netlify). Vide = même origine uniquement. */
  corsOrigin: str('CORS_ORIGIN'),

  // Essais gratuits (cahier des charges §2)
  trialTasks: num('TRIAL_TASKS', 5),
  /** Usage équitable pour les abonnés (protège les coûts d'IA). */
  dailyTaskCap: num('DAILY_TASK_CAP', 300),

  // Sessions
  sessionTtlHours: num('SESSION_TTL_HOURS', 24 * 14),
  adminSessionTtlMinutes: num('ADMIN_SESSION_TTL_MINUTES', 120),
  /** §9 : chaque tentative de connexion/récupération admin expire après 20 minutes. */
  loginAttemptWindowMinutes: 20,
  otpTtlMinutes: num('OTP_TTL_MINUTES', 10),
  otpMaxAttempts: 5,

  // Limitation de débit (§2 et §8)
  signupPerIpPerHour: num('RL_SIGNUP_PER_IP_HOUR', 20),
  loginPerIpPer10Min: num('RL_LOGIN_PER_IP_10MIN', 20),
  otpSendPerTargetPerHour: num('RL_OTP_PER_TARGET_HOUR', 5),
  apiPerIpPerMinute: num('RL_API_PER_IP_MIN', 240),
  /** Anti-rafale (DoS applicatif) : seuil court terme par IP, plus sévère que la limite par minute.
   * Beaucoup plus haut en test : les suites de tests appellent l'API en rafale légitime sur une IP partagée. */
  apiBurstPerIpPerSecond: num('RL_API_BURST_PER_IP_SEC', isTest ? 100_000 : 15),
  apiBurstWindowMs: num('RL_API_BURST_WINDOW_MS', 2000),
  /** Au-delà de ce nombre de comptes créés depuis une même IP en 15 min -> vérification supplémentaire (jamais de blocage VPN). */
  signupBurstThreshold: num('SIGNUP_BURST_THRESHOLD', 5),

  // Sécurité (§8)
  failedLoginsBeforeLock: num('FAILED_LOGINS_BEFORE_LOCK', 8),
  accountLockMinutes: num('ACCOUNT_LOCK_MINUTES', 15),
  ipBlockFailedLogins: num('IP_BLOCK_FAILED_LOGINS', 30), // en 10 minutes
  ipBlockProbeHits: num('IP_BLOCK_PROBE_HITS', 8), // sondages de chemins sensibles (/.env, /wp-admin…) en 10 min
  ipBlockHours: num('IP_BLOCK_HOURS', 24),
  /** Piège (honeypot) : durée de conservation des informations captées sur un intrus avant purge automatique. */
  honeypotRetentionDays: num('HONEYPOT_RETENTION_DAYS', 10),
  loginLogRetentionDays: num('LOGIN_LOG_RETENTION_DAYS', 180), // À valider avec la réglementation applicable (ARTCI / RGPD)

  // Retraits (§5) : toute sortie de fonds (automatique ou déclenchée depuis l'admin) exige une confirmation par lien envoyé par email.
  payoutConfirmTtlHours: num('PAYOUT_CONFIRM_TTL_HOURS', 24),

  // Administrateur initial (§9) : valeurs lues dans l'environnement, jamais dans le code.
  adminEmail: str('ADMIN_EMAIL').toLowerCase(),
  adminInitialPassword: str('ADMIN_INITIAL_PASSWORD'),
  ownerNotifyEmail: str('OWNER_NOTIFY_EMAIL', str('ADMIN_EMAIL')).toLowerCase(),
  ownerNotifyPhone: str('OWNER_NOTIFY_PHONE'),

  // Paiements (§3)
  paymentProvider: str('PAYMENT_PROVIDER', isProd ? 'cinetpay' : 'mock') as 'cinetpay' | 'mock',
  payoutProvider: str('PAYOUT_PROVIDER', isProd ? 'cinetpay' : 'mock') as 'cinetpay' | 'mock',
  allowMock: bool('ALLOW_MOCK_PROVIDERS', !isProd),
  cinetpay: {
    apiKey: str('CINETPAY_APIKEY'),
    siteId: str('CINETPAY_SITE_ID'),
    secretKey: str('CINETPAY_SECRET_KEY'),
    transferPassword: str('CINETPAY_TRANSFER_PASSWORD'),
    checkoutBase: str('CINETPAY_CHECKOUT_BASE', 'https://api-checkout.cinetpay.com/v2'),
    transferBase: str('CINETPAY_TRANSFER_BASE', 'https://client.cinetpay.com/v1'),
  },
  // Stripe : cartes, Apple Pay, Google Pay (via Checkout hébergé) et prélèvement SEPA — surtout pour l'Europe (CinetPay ne les propose pas).
  stripe: { secretKey: str('STRIPE_SECRET_KEY'), webhookSecret: str('STRIPE_WEBHOOK_SECRET'), base: str('STRIPE_API_BASE', 'https://api.stripe.com') },
  payoutMinAmount: num('PAYOUT_MIN_AMOUNT', 100),
  payoutMaxAttempts: num('PAYOUT_MAX_ATTEMPTS', 8),

  // Notifications
  emailProvider: str('EMAIL_PROVIDER', 'console') as 'console' | 'resend',
  resendApiKey: str('RESEND_API_KEY'),
  emailFrom: str('EMAIL_FROM', 'Velyra AI <no-reply@example.com>'),
  smsProvider: str('SMS_PROVIDER', 'console') as 'console' | 'twilio',
  twilio: { accountSid: str('TWILIO_ACCOUNT_SID'), authToken: str('TWILIO_AUTH_TOKEN'), from: str('TWILIO_FROM') },

  googleClientId: str('GOOGLE_CLIENT_ID'),
  appleClientId: str('APPLE_CLIENT_ID'), // « Services ID » Apple utilisé pour la connexion web
  cronSecret: str('CRON_SECRET'), // protège /api/cron/daily (planificateur externe qui réveille le serveur)

  // Réseaux sociaux (connexion des comptes des utilisateurs, offre payante « Social »). Chaque plateforme exige une application validée.
  social: {
    tiktok: { clientKey: str('TIKTOK_CLIENT_KEY'), clientSecret: str('TIKTOK_CLIENT_SECRET') },
    youtube: { clientId: str('YOUTUBE_CLIENT_ID'), clientSecret: str('YOUTUBE_CLIENT_SECRET') },
    meta: { appId: str('META_APP_ID'), appSecret: str('META_APP_SECRET'), version: str('META_GRAPH_VERSION', 'v26.0') },
  },

  // Fournisseurs d'IA (routeur de modèles). Un fournisseur est actif s'il a une clé ET un modèle.
  ai: {
    defaultProvider: str('AI_DEFAULT_PROVIDER', 'openai'),
    // Agents système (analyses quotidiennes) : modèle économique par défaut, modifiable.
    systemAgentProvider: str('SYSTEM_AGENT_PROVIDER', 'openai'),
    systemAgentModel: str('SYSTEM_AGENT_MODEL', 'gpt-6-luna'),
    // Auditeur indépendant : de préférence un AUTRE fournisseur que les agents (sinon le même, avec une autre consigne).
    auditorProvider: str('AUDITOR_PROVIDER'), auditorModel: str('AUDITOR_MODEL'),
    maxOutputTokens: num('AI_MAX_OUTPUT_TOKENS', 1024),
    anthropic: { key: str('ANTHROPIC_API_KEY'), model: str('ANTHROPIC_MODEL', 'claude-sonnet-5-5'), base: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com') },
    openai: { key: str('OPENAI_API_KEY'), model: str('OPENAI_MODEL', 'gpt-6.1-sol'), base: str('OPENAI_BASE_URL', 'https://api.openai.com/v1') },
    mistral: { key: str('MISTRAL_API_KEY'), model: str('MISTRAL_MODEL'), base: str('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1') },
    // Coupe-circuit de dépense (§1.3) : plafond quotidien en JETONS (unité fiable, renvoyée par chaque fournisseur),
    // pas en dollars — convertir en coût exact dépend du tarif réellement négocié par Franck chez chaque fournisseur,
    // que ce serveur ne connaît pas. Au-delà, les nouvelles requêtes basculent en mode démonstration jusqu'au
    // lendemain (voir services/aibudget.ts) plutôt que de continuer à dépenser. 0 = désactivé.
    dailyTokenBudget: num('AI_DAILY_TOKEN_BUDGET', 3_000_000),
    // Estimation de coût optionnelle (affichage seulement, n'affecte pas le coupe-circuit) : $ par million de jetons.
    // Laissé à 0 par défaut — un prix non confirmé par Franck ne doit pas être présenté comme un fait. À renseigner
    // avec le tarif réel de son contrat auprès de chaque fournisseur s'il veut voir une estimation en dollars.
    costPerMTokUsd: {
      anthropic: num('AI_COST_ANTHROPIC_PER_MTOK', 0),
      openai: num('AI_COST_OPENAI_PER_MTOK', 0),
      mistral: num('AI_COST_MISTRAL_PER_MTOK', 0),
    },
  },
  // Drapeaux de fonctionnalités (comme dans le README Velyra AI).
  flags: {
    agents: bool('ENABLE_AGENTS', true), workflows: bool('ENABLE_WORKFLOWS', true), marketplace: bool('ENABLE_MARKETPLACE', true),
    memory: bool('ENABLE_MEMORY', true), documents: bool('ENABLE_DOCUMENTS', true), tiktok: bool('ENABLE_TIKTOK', true), publicApi: bool('ENABLE_PUBLIC_API', true),
  },

  // Exploitation (§7)
  backupDir: str('BACKUP_DIR', resolve(root, 'backups')),
  backupKeep: num('BACKUP_KEEP', 14),
  jobsEnabled: bool('JOBS_ENABLED', true),
  webDir: resolve(str('WEB_DIR', './web/dist')),
};

export type Config = typeof config;

export function assertProductionConfig(): string[] {
  const problems: string[] = [];
  if (!isProd) return problems;
  if (config.paymentProvider === 'mock' && !config.allowMock) problems.push('PAYMENT_PROVIDER=mock interdit en production');
  if (config.paymentProvider === 'cinetpay' && (!config.cinetpay.apiKey || !config.cinetpay.siteId || !config.cinetpay.secretKey))
    problems.push('CINETPAY_APIKEY, CINETPAY_SITE_ID et CINETPAY_SECRET_KEY sont requis');
  if (!config.databaseUrl) problems.push('DATABASE_URL (PostgreSQL) est requis en production');
  if (config.stripe.secretKey && !config.stripe.webhookSecret) problems.push('STRIPE_WEBHOOK_SECRET est requis quand STRIPE_SECRET_KEY est défini');
  if (!config.appUrl.startsWith('https://')) problems.push('APP_URL doit être en https en production');
  return problems;
}
