import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmacSha256 = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Code numérique à n chiffres, tiré avec un générateur cryptographique. */
export function randomDigits(n = 6): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randomInt(0, 10));
  return s;
}

// ---- Mots de passe : scrypt (intégré à Node), sel aléatoire par mot de passe --------------
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 };
const scryptAsync = (pw: string, salt: Buffer, o: typeof SCRYPT) =>
  new Promise<Buffer>((res, rej) => scrypt(pw.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) { await scryptAsync(pw, Buffer.alloc(16), SCRYPT); return false; } // temps constant approximatif
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scryptAsync(pw, Buffer.from(salt, 'base64'), { ...SCRYPT, N: +N, r: +r, p: +p });
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Règle admin (§9) : 16 caractères minimum avec majuscule, minuscule, chiffre et caractère spécial. */
export function adminPasswordProblems(pw: string): string[] {
  const out: string[] = [];
  if (pw.length < 16) out.push('16 caractères minimum');
  if (!/[a-z]/.test(pw)) out.push('une minuscule');
  if (!/[A-Z]/.test(pw)) out.push('une majuscule');
  if (!/\d/.test(pw)) out.push('un chiffre');
  if (!/[^A-Za-z0-9]/.test(pw)) out.push('un caractère spécial');
  return out;
}
export function userPasswordProblems(pw: string): string[] {
  const out: string[] = [];
  if (pw.length < 10) out.push('10 caractères minimum');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) out.push('au moins une lettre et un chiffre');
  if (pw.length > 200) out.push('200 caractères maximum');
  return out;
}

// ---- Chiffrement des données sensibles au repos (AES-256-GCM) -----------------------------
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('Format chiffré inconnu');
  const d = createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---- Variante binaire (AES-256-GCM) : pour des données non textuelles (ex. sauvegardes compressées) --
const BIN_MAGIC = Buffer.from('VLB1');
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([BIN_MAGIC, iv, c.getAuthTag(), ct]);
}
export function decryptBuffer(blob: Buffer): Buffer {
  if (!blob.subarray(0, 4).equals(BIN_MAGIC)) throw new Error('Format chiffré binaire inconnu');
  const iv = blob.subarray(4, 16), tag = blob.subarray(16, 32), ct = blob.subarray(32);
  const d = createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
