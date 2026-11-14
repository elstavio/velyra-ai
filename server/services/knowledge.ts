import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, bad, nowIso, str, uid } from '../lib/util.js';

// ----------------------------------------------------------------------------- mémoire persistante
const MAX_MEMORIES = 100;
export async function listMemories(db: Db, userId: string) {
  return db.query<{ id: string; content: string; created_at: string }>(`SELECT id,content,created_at FROM memories WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
}
export async function addMemory(db: Db, userId: string, content: unknown) {
  const text = str(content, 'souvenir', { min: 2, max: 500 });
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE user_id=$1`, [userId]))?.n ?? 0;
  if (n >= MAX_MEMORIES) throw bad('memory_full', `Limite de ${MAX_MEMORIES} souvenirs atteinte : supprimez-en pour continuer`);
  const id = uid();
  await db.run(`INSERT INTO memories (id,user_id,content,created_at) VALUES ($1,$2,$3,$4)`, [id, userId, text, nowIso()]);
  return id;
}
export async function deleteMemory(db: Db, userId: string, id: string) {
  const r = await db.run(`DELETE FROM memories WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Souvenir introuvable');
}

// ----------------------------------------------------------------------------- documents + recherche
const STOP = new Set('le la les un une des de du et en au aux ce ces que qui quoi dans sur pour par avec sans est sont a ont ou où the of and to in is are for on with'.split(' '));
export function tokenize(s: string): string[] {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export function chunkText(text: string, size = 800, overlap = 100): string[] {
  const clean = text.replace(/\r/g, '').trim();
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size);
    if (end < clean.length) { // coupe sur une fin de phrase/ligne si possible
      const cut = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf('. ', end));
      if (cut > i + size / 2) end = cut + 1;
    }
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out.filter(Boolean);
}

const MAX_DOCS = 50, MAX_CHARS = 200_000;
export async function addDocument(db: Db, userId: string, title: unknown, content: unknown, source: 'text' | 'pdf' | 'docx' = 'text') {
  const t = str(title, 'titre', { min: 1, max: 150 });
  const text = String(content ?? '');
  if (text.trim().length < 20) throw bad('document_empty', 'Document trop court');
  if (text.length > MAX_CHARS) throw bad('document_too_large', `Document trop long (maximum ${MAX_CHARS} caractères)`);
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM documents WHERE user_id=$1`, [userId]))?.n ?? 0;
  if (n >= MAX_DOCS) throw bad('documents_full', `Limite de ${MAX_DOCS} documents atteinte`);
  const id = uid();
  const chunks = chunkText(text);
  const chunkIds = chunks.map(() => uid());
  await db.tx(async (tx) => {
    await tx.run(`INSERT INTO documents (id,user_id,title,chars,created_at,source) VALUES ($1,$2,$3,$4,$5,$6)`, [id, userId, t, text.length, nowIso(), source]);
    for (let i = 0; i < chunks.length; i++) await tx.run(`INSERT INTO doc_chunks (id,document_id,user_id,idx,text) VALUES ($1,$2,$3,$4,$5)`, [chunkIds[i], id, userId, i, chunks[i]]);
  });
  // Calcul des embeddings en arrière-plan : n'empêche jamais l'ajout du document si le fournisseur est indisponible.
  void embedChunks(db, chunkIds, chunks).catch(() => undefined);
  return { id, chunks: chunks.length };
}
/** Pagination (§3.14) : évite de charger tous les documents d'un utilisateur en une seule requête si leur nombre grandit. */
export async function listDocuments(db: Db, userId: string, limit = 50, offset = 0) {
  const lim = Math.min(200, Math.max(1, limit));
  const off = Math.max(0, offset);
  const [documents, totalRow] = await Promise.all([
    db.query<any>(`SELECT id,title,chars,source,created_at FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [userId, lim, off]),
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM documents WHERE user_id=$1`, [userId]),
  ]);
  return { documents, total: totalRow?.n ?? documents.length, limit: lim, offset: off };
}
export async function getDocumentText(db: Db, userId: string, id: string): Promise<{ title: string; text: string }> {
  const d = await db.get<{ title: string }>(`SELECT title FROM documents WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!d) throw new HttpError(404, 'not_found', 'Document introuvable');
  const rows = await db.query<{ text: string }>(`SELECT text FROM doc_chunks WHERE document_id=$1 AND user_id=$2 ORDER BY idx`, [id, userId]);
  return { title: d.title, text: rows.map((r) => r.text).join('\n') };
}
export async function deleteDocument(db: Db, userId: string, id: string) {
  const r = await db.tx(async (tx) => {
    const d = await tx.run(`DELETE FROM documents WHERE id=$1 AND user_id=$2`, [id, userId]);
    if (d.changes) await tx.run(`DELETE FROM doc_chunks WHERE document_id=$1 AND user_id=$2`, [id, userId]);
    return d;
  });
  if (!r.changes) throw new HttpError(404, 'not_found', 'Document introuvable');
}

export interface Hit { documentId: string; title: string; text: string; score: number }

/**
 * Recherche lexicale BM25 (mots-clés pondérés) dans les documents de l'utilisateur.
 * IMPORTANT : ce n'est PAS une recherche sémantique par embeddings (qui nécessiterait un modèle d'embeddings/Qdrant).
 */
export async function searchDocuments(db: Db, userId: string, query: string, limit = 5): Promise<Hit[]> {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const rows = await db.query<{ id: string; document_id: string; text: string; title: string }>(
    `SELECT c.id, c.document_id, c.text, d.title FROM doc_chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=$1 LIMIT 5000`, [userId]);
  if (!rows.length) return [];
  const docs = rows.map((r) => { const toks = tokenize(r.text); const tf = new Map<string, number>(); for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1); return { r, tf, len: toks.length }; });
  const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;
  const N = docs.length, k1 = 1.5, b = 0.75;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
  const scored = docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t) ?? 0; if (!f) continue;
      const n = df.get(t)!;
      s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)));
    }
    return { documentId: d.r.document_id, title: d.r.title, text: d.r.text, score: s };
  }).filter((h) => h.score > 0).sort((a, b2) => b2.score - a.score);
  return scored.slice(0, limit);
}

// ----------------------------------------------------------------------------- recherche sémantique (optionnelle, embeddings)
/**
 * La recherche sémantique nécessite un fournisseur d'embeddings. Seul OpenAI en expose un dans cette
 * architecture (text-embedding-3-small) ; sans clé OpenAI configurée, cette fonctionnalité est honnêtement
 * indisponible et l'appelant doit se replier sur la recherche lexicale (BM25).
 */
const EMBEDDING_MODEL = 'text-embedding-3-small';
export const embeddingsAvailable = () => !!config.ai.openai.key;

async function embed(texts: string[]): Promise<number[][] | null> {
  if (!texts.length || !embeddingsAvailable()) return null;
  const r = await fetch(`${config.ai.openai.base}/embeddings`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.openai.key}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.map((t) => t.slice(0, 8000)) }),
  });
  if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
  const j: any = await r.json();
  const rows = (j.data ?? []).sort((a: any, b: any) => a.index - b.index);
  return rows.map((row: any) => row.embedding as number[]);
}

async function embedChunks(db: Db, chunkIds: string[], texts: string[]) {
  const vectors = await embed(texts);
  if (!vectors) return; // pas de fournisseur configuré : les chunks restent sans embedding, la recherche lexicale continue de fonctionner
  await db.tx(async (tx) => {
    for (let i = 0; i < chunkIds.length; i++) await tx.run(`UPDATE doc_chunks SET embedding=$2, embedding_model=$3 WHERE id=$1`, [chunkIds[i], JSON.stringify(vectors[i]), EMBEDDING_MODEL]);
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Retourne null si aucun embedding n'est disponible (fournisseur non configuré, ou documents pas encore indexés) : l'appelant doit alors utiliser searchDocuments (BM25). */
export async function semanticSearch(db: Db, userId: string, query: string, limit = 5): Promise<Hit[] | null> {
  if (!embeddingsAvailable()) return null;
  const rows = await db.query<{ document_id: string; text: string; title: string; embedding: string | null }>(
    `SELECT c.document_id, c.text, d.title, c.embedding FROM doc_chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=$1 AND c.embedding IS NOT NULL LIMIT 5000`, [userId]);
  if (!rows.length) return null;
  const [qVec] = (await embed([query])) ?? [];
  if (!qVec) return null;
  const scored = rows.map((r) => ({ documentId: r.document_id, title: r.title, text: r.text, score: cosine(qVec, JSON.parse(r.embedding!)) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
