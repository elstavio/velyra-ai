import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { nowIso, uid } from '../lib/util.js';

/** Boîte d'envoi en mémoire, utilisée par les tests et le mode développement. */
export const devOutbox: { channel: string; to: string; subject?: string; body: string }[] = [];

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (config.emailProvider === 'resend') {
    // POST https://api.resend.com/emails — Authorization: Bearer <clé> ; champs from, to, subject, text (doc Resend « Send Email »)
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to, subject, text: body }),
    });
    if (!r.ok) throw new Error(`Resend HTTP ${r.status}`);
    return;
  }
  devOutbox.push({ channel: 'email', to, subject, body });
  if (!config.isProd && process.env.NODE_ENV !== 'test') console.log(`[email → ${to}] ${subject}\n${body}\n`);
}

async function sendSms(to: string, body: string): Promise<void> {
  if (config.smsProvider === 'twilio') {
    // POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json (form-urlencoded : To, From, Body), auth Basic sid:token
    const { accountSid, authToken, from } = config.twilio;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!r.ok) throw new Error(`Twilio HTTP ${r.status}`);
    return;
  }
  devOutbox.push({ channel: 'sms', to, body });
  if (!config.isProd && process.env.NODE_ENV !== 'test') console.log(`[sms → ${to}] ${body}\n`);
}

export interface NotifyOpts { sensitive?: boolean }

async function deliver(db: Db, channel: 'email' | 'sms', to: string, subject: string | undefined, body: string, o: NotifyOpts) {
  const id = uid();
  // Les codes à usage unique ne sont jamais conservés en base (journal de notifications expurgé).
  const stored = o.sensitive ? '[contenu sensible non conservé]' : body;
  await db.run(`INSERT INTO notifications (id, channel, recipient, subject, body, status, created_at) VALUES ($1,$2,$3,$4,$5,'queued',$6)`, [id, channel, to, subject ?? null, stored, nowIso()]);
  try {
    if (channel === 'email') await sendEmail(to, subject ?? '', body); else await sendSms(to, body);
    await db.run(`UPDATE notifications SET status='sent', sent_at=$2 WHERE id=$1`, [id, nowIso()]);
    return true;
  } catch (e: any) {
    await db.run(`UPDATE notifications SET status='failed', error=$2 WHERE id=$1`, [id, String(e?.message ?? e).slice(0, 300)]);
    return false;
  }
}

export const notifyEmail = (db: Db, to: string, subject: string, body: string, o: NotifyOpts = {}) => deliver(db, 'email', to, subject, body, o);
export const notifySms = (db: Db, to: string, body: string, o: NotifyOpts = {}) => deliver(db, 'sms', to, undefined, body, o);

/** Alerte au propriétaire par email (et par SMS si urgent et configuré). Ne lève jamais d'exception. */
export async function notifyOwner(db: Db, subject: string, body: string, { sms = false }: { sms?: boolean } = {}) {
  try {
    if (config.ownerNotifyEmail) await notifyEmail(db, config.ownerNotifyEmail, `[Velyra AI] ${subject}`, body);
    if (sms && config.ownerNotifyPhone) await notifySms(db, config.ownerNotifyPhone, `[Velyra AI] ${subject}`);
  } catch { /* la notification ne doit jamais casser le flux appelant */ }
}
