/** Limiteur à fenêtre glissante en mémoire (une instance). Pour plusieurs instances, déplacer vers la base ou Redis. */
const buckets = new Map<string, number[]>();

export function hit(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; count: number; retryAfterSec: number } {
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  const allowed = arr.length < limit;
  if (allowed) arr.push(now);
  buckets.set(key, arr);
  return { allowed, count: arr.length, retryAfterSec: allowed ? 0 : Math.ceil((windowMs - (now - arr[0])) / 1000) };
}
export function peek(key: string, windowMs: number, now = Date.now()): number {
  return (buckets.get(key) ?? []).filter((t) => now - t < windowMs).length;
}
export function resetKey(key: string) { buckets.delete(key); }
export function sweep(maxAgeMs = 3_600_000, now = Date.now()) {
  for (const [k, v] of buckets) {
    const f = v.filter((t) => now - t < maxAgeMs);
    if (f.length) buckets.set(k, f); else buckets.delete(k);
  }
}
