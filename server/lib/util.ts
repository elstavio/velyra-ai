import { randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const addMinutes = (m: number, from = Date.now()) => new Date(from + m * 60_000).toISOString();
export const addDays = (d: number, from = Date.now()) => new Date(from + d * 86_400_000).toISOString();
export const uid = () => randomUUID();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
export const bad = (code: string, message: string, extra?: Record<string, unknown>) => new HttpError(400, code, message, extra);
export const unauthorized = (message = 'Authentification requise') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Accès refusé', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Introuvable') => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

export function parseJson<T = any>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export function normalizeEmail(v: unknown): string {
  const e = String(v ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw bad('invalid_email', 'Adresse email invalide');
  return e;
}
/** Numéro au format international E.164 (+22507…). Les espaces et tirets sont tolérés. */
export function normalizePhone(v: unknown): string {
  const p = String(v ?? '').replace(/[\s.\-()]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw bad('invalid_phone', 'Numéro invalide : utilisez le format international, ex. +2250102030405');
  return p;
}
export function str(v: unknown, name: string, { min = 0, max = 500, optional = false } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw bad('invalid_field', `Champ requis : ${name}`);
  }
  const s = String(v).trim();
  if (s.length < min || s.length > max) throw bad('invalid_field', `Champ invalide : ${name}`);
  return s;
}
export function int(v: unknown, name: string, { min = 0, max = 2_000_000_000, optional = false } = {}): number {
  if ((v === undefined || v === null || v === '') && optional) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad('invalid_field', `Nombre invalide : ${name}`);
  return n;
}
