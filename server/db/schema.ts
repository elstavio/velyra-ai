import type { Db } from './index.js';

// Sous-ensemble SQL portable SQLite / PostgreSQL : TEXT, INTEGER, BIGINT, horodatages ISO-8601 en TEXT.
const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    phone TEXT,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    country TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    trials_used INTEGER NOT NULL DEFAULT 0,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    extra_verification INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  )`,
  // §2 : un seul compte par numéro de téléphone VÉRIFIÉ pour bénéficier des essais.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_verified_phone ON users(phone) WHERE phone_verified = 1`,
  `CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, target TEXT NOT NULL,
    code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_otp_user ON otp_codes(user_id, purpose)`,
  `CREATE TABLE IF NOT EXISTS login_challenges (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, steps_done TEXT NOT NULL DEFAULT '[]',
    device_hash TEXT, ip TEXT, user_agent TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    ip TEXT, user_agent TEXT, device_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS known_devices (
    user_id TEXT NOT NULL, device_hash TEXT NOT NULL, ip_prefix TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (user_id, device_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS login_logs (
    id TEXT PRIMARY KEY, user_id TEXT, email TEXT, ip TEXT, user_agent TEXT,
    success INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_login_logs_time ON login_logs(created_at)`,
  `CREATE TABLE IF NOT EXISTS plans (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, duration_days INTEGER NOT NULL,
    features TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS plan_prices (
    plan_code TEXT NOT NULL, currency TEXT NOT NULL, amount BIGINT NOT NULL, PRIMARY KEY (plan_code, currency)
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, user_id TEXT, plan_code TEXT NOT NULL, amount BIGINT NOT NULL, currency TEXT NOT NULL,
    country TEXT NOT NULL, region TEXT NOT NULL, provider TEXT NOT NULL, channel TEXT NOT NULL,
    provider_ref TEXT NOT NULL, provider_token TEXT, payment_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending', fraud_flag INTEGER NOT NULL DEFAULT 0, fraud_reasons TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT, raw TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_ref ON payments(provider, provider_ref)`,
  `CREATE INDEX IF NOT EXISTS ix_payments_user ON payments(user_id)`,
  `CREATE INDEX IF NOT EXISTS ix_payments_status ON payments(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_code TEXT NOT NULL, payment_id TEXT NOT NULL UNIQUE,
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_subs_user ON subscriptions(user_id, ends_at)`,
  `CREATE TABLE IF NOT EXISTS wallets (currency TEXT PRIMARY KEY, balance BIGINT NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wallet_ledger (
    id TEXT PRIMARY KEY, currency TEXT NOT NULL, kind TEXT NOT NULL, amount BIGINT NOT NULL, balance_after BIGINT NOT NULL,
    payment_id TEXT, payout_id TEXT, note TEXT, created_at TEXT NOT NULL
  )`,
  // Anti double-transaction (§5.1) : une seule écriture de chaque type par paiement / par transfert.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_payment ON wallet_ledger(payment_id, kind) WHERE payment_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_payout ON wallet_ledger(payout_id, kind) WHERE payout_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS payout_accounts (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, country TEXT NOT NULL, prefix TEXT NOT NULL,
    phone_enc TEXT NOT NULL, phone_last4 TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY, payment_id TEXT NOT NULL UNIQUE, currency TEXT NOT NULL, amount BIGINT NOT NULL,
    channel TEXT, account_id TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT, provider TEXT, provider_ref TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_payouts_status ON payouts(status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS fraud_reports (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reporter_id TEXT, source TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, reviewed_at TEXT, resolution TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL, ip TEXT, user_id TEXT, detail TEXT,
    created_at TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_sec_time ON security_events(created_at)`,
  `CREATE TABLE IF NOT EXISTS ip_blocks (
    ip TEXT PRIMARY KEY, reason TEXT NOT NULL, permanent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, expires_at TEXT, created_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, input TEXT, output TEXT,
    billing TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done', created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_tasks_user ON tasks(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS tiktok_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL, country TEXT, category TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tiktok_posts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, posted_at TEXT NOT NULL, caption TEXT, hashtags TEXT,
    views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0, format TEXT, duration_s INTEGER, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_tt_posts_acc ON tiktok_posts(account_id, posted_at)`,
  `CREATE TABLE IF NOT EXISTS tiktok_snapshots (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, taken_on TEXT NOT NULL, followers INTEGER NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_tt_snap ON tiktok_snapshots(account_id, taken_on)`,
  `CREATE TABLE IF NOT EXISTS ai_proposals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, evidence TEXT,
    fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_ai_prop_fp ON ai_proposals(fingerprint, status)`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, agent TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL, finished_at TEXT, summary TEXT, findings TEXT,
    provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_agent_runs ON agent_runs(agent, day)`,
  `CREATE TABLE IF NOT EXISTS social_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, external_id TEXT NOT NULL, display_name TEXT NOT NULL,
    access_enc TEXT NOT NULL, refresh_enc TEXT, expires_at TEXT, refresh_expires_at TEXT, scopes TEXT, extra TEXT,
    status TEXT NOT NULL DEFAULT 'active', metrics TEXT, synced_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_social_acc ON social_accounts(user_id, platform, external_id)`,
  `CREATE TABLE IF NOT EXISTS social_snapshots (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, day TEXT NOT NULL, followers INTEGER, posts INTEGER, views INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_social_snap ON social_snapshots(account_id, day)`,
  `CREATE TABLE IF NOT EXISTS token_balances (user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS token_ledger (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, note TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_token_ledger_ref ON token_ledger(reason, ref)`,
  `CREATE INDEX IF NOT EXISTS ix_token_ledger_user ON token_ledger(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT, platform TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, body TEXT NOT NULL,
    link TEXT, image_url TEXT, recipient TEXT, status TEXT NOT NULL DEFAULT 'draft', content_hash TEXT NOT NULL, remote_id TEXT, error TEXT,
    created_by TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_social_posts ON social_posts(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS post_approvals (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL, content_hash TEXT NOT NULL, authorized INTEGER NOT NULL, verified INTEGER NOT NULL,
    statement TEXT NOT NULL, ip TEXT, outcome TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS integrity_findings (
    id TEXT PRIMARY KEY, check_id TEXT NOT NULL, severity TEXT NOT NULL, detail TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    resolved_at TEXT, auto_fixed INTEGER NOT NULL DEFAULT 0, fix_note TEXT, notified_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_integrity ON integrity_findings(check_id, resolved_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS social_content (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_social_content ON social_content(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ai_runs (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, metrics TEXT, anomalies INTEGER NOT NULL DEFAULT 0,
    proposals_created INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS health_checks (
    id TEXT PRIMARY KEY, ok INTEGER NOT NULL, detail TEXT, latency_ms INTEGER, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS error_log (
    id TEXT PRIMARY KEY, message TEXT NOT NULL, stack TEXT, route TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, sent_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, path TEXT NOT NULL, bytes BIGINT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TEXT NOT NULL
  )`,
  // ---------------------------------------------------------------- Velyra AI : conversations, mémoire, documents, agents, workflows, marketplace, API
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, system_prompt TEXT NOT NULL,
    provider TEXT, use_memory INTEGER NOT NULL DEFAULT 1, use_documents INTEGER NOT NULL DEFAULT 0,
    origin_listing_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_agents_user ON agents(user_id)`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, agent_id TEXT, archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_conv_user ON conversations(user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, provider TEXT, model TEXT,
    tokens_in INTEGER, tokens_out INTEGER, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_mem_user ON memories(user_id)`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, chars INTEGER NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS doc_chunks (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, user_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_chunks_user ON doc_chunks(user_id)`,
  `CREATE INDEX IF NOT EXISTS ix_chunks_doc ON doc_chunks(document_id)`,
  `CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, steps TEXT NOT NULL, origin_listing_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, input TEXT, output TEXT,
    log TEXT, created_at TEXT NOT NULL, finished_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS marketplace_listings (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', installs INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    last_used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
  )`,
  // ---------------------------------------------------------------- Piège anti-intrusion (honeypot) et confirmation des retraits
  `CREATE TABLE IF NOT EXISTS honeypot_hits (
    id TEXT PRIMARY KEY, ip TEXT NOT NULL, ip_prefix TEXT, path TEXT NOT NULL, method TEXT NOT NULL,
    user_agent TEXT, device_hash TEXT, headers TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_honeypot_time ON honeypot_hits(created_at)`,
  `CREATE TABLE IF NOT EXISTS payout_confirmations (
    id TEXT PRIMARY KEY, payout_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    confirmed_at TEXT, confirmed_ip TEXT, sent_count INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS ix_payout_confirm_status ON payout_confirmations(status)`,
  // ---------------------------------------------------------------- Passkeys / WebAuthn (admin)
  `CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE,
    public_key_x TEXT NOT NULL, public_key_y TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
    name TEXT, created_at TEXT NOT NULL, last_used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_webauthn_cred_user ON webauthn_credentials(user_id)`,
  `CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, challenge TEXT NOT NULL,
    login_challenge_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
];

/** Colonnes ajoutées après la première version : ajout idempotent (SQLite n'a pas ADD COLUMN IF NOT EXISTS). */
async function addColumn(db: Db, table: string, column: string, type: string) {
  try { await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); } catch (e: any) {
    if (!/duplicate column|already exists/i.test(String(e?.message ?? e))) throw e;
  }
}

export async function migrate(db: Db): Promise<void> {
  for (const s of statements) await db.run(s);
  await addColumn(db, 'users', 'apple_sub', 'TEXT');
  await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_apple_sub ON users(apple_sub)`);
  // Recherche sémantique optionnelle (embeddings) et traçabilité de l'origine d'un document (texte collé, PDF, Word).
  await addColumn(db, 'doc_chunks', 'embedding', 'TEXT');
  await addColumn(db, 'doc_chunks', 'embedding_model', 'TEXT');
  await addColumn(db, 'documents', 'source', 'TEXT');
}

/** Tables exportées par la sauvegarde logique (ordre de restauration). */
export const BACKUP_TABLES = [
  'users', 'plans', 'plan_prices', 'payments', 'subscriptions', 'wallets', 'wallet_ledger', 'payout_accounts', 'payouts',
  'fraud_reports', 'security_events', 'ip_blocks', 'tasks', 'tiktok_accounts', 'tiktok_posts', 'tiktok_snapshots', 'social_accounts', 'social_snapshots', 'social_content', 'token_balances', 'token_ledger', 'social_posts', 'post_approvals', 'integrity_findings',
  'ai_proposals', 'ai_runs', 'agent_runs', 'settings', 'audit_log', 'known_devices',
  'agents', 'conversations', 'messages', 'memories', 'documents', 'doc_chunks', 'workflows', 'workflow_runs', 'marketplace_listings', 'api_keys',
  'honeypot_hits', 'payout_confirmations', 'webauthn_credentials',
];
