import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, bad, forbidden, nowIso, parseJson, str, uid } from '../lib/util.js';
import type { UserRow } from './auth.js';
import { ask, loadAgent } from './chat.js';
import { audit } from './admin.js';

const need = (flag: keyof typeof config.flags, label: string) => { if (!config.flags[flag]) throw forbidden(`${label} : fonctionnalité désactivée`, 'feature_disabled'); };

// ----------------------------------------------------------------------------- agents
const MAX_AGENTS = 20;
export async function listAgents(db: Db, userId: string) {
  need('agents', 'Agents');
  return db.query<any>(`SELECT id,name,description,system_prompt,provider,use_memory,use_documents,created_at FROM agents WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
}
export async function saveAgent(db: Db, userId: string, b: any, id?: string) {
  need('agents', 'Agents');
  const f = { name: str(b.name, 'nom', { min: 2, max: 60 }), description: str(b.description, 'description', { max: 300, optional: true }), prompt: str(b.systemPrompt, 'consignes', { min: 5, max: 4000 }), provider: b.provider ? str(b.provider, 'fournisseur', { max: 20 }) : null };
  const mem = b.useMemory === false ? 0 : 1, docs = b.useDocuments === true ? 1 : 0, now = nowIso();
  if (id) {
    const r = await db.run(`UPDATE agents SET name=$3,description=$4,system_prompt=$5,provider=$6,use_memory=$7,use_documents=$8,updated_at=$9 WHERE id=$1 AND user_id=$2`, [id, userId, f.name, f.description, f.prompt, f.provider, mem, docs, now]);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Agent introuvable');
    return id;
  }
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE user_id=$1`, [userId]))?.n ?? 0;
  if (n >= MAX_AGENTS) throw bad('agents_full', `Limite de ${MAX_AGENTS} agents atteinte`);
  const nid = uid();
  await db.run(`INSERT INTO agents (id,user_id,name,description,system_prompt,provider,use_memory,use_documents,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [nid, userId, f.name, f.description, f.prompt, f.provider, mem, docs, now]);
  return nid;
}
export async function deleteAgent(db: Db, userId: string, id: string) {
  const r = await db.run(`DELETE FROM agents WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Agent introuvable');
}

// ----------------------------------------------------------------------------- workflows
export interface Step { type: 'prompt' | 'agent'; agentId?: string; prompt: string }
const MAX_STEPS = 8;

export function validateSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STEPS) throw bad('invalid_steps', `Un workflow contient de 1 à ${MAX_STEPS} étapes`);
  return raw.map((s: any, i) => {
    const type = s?.type === 'agent' ? 'agent' : 'prompt';
    const prompt = str(s?.prompt, `étape ${i + 1}`, { min: 2, max: 2000 });
    if (type === 'agent' && !s.agentId) throw bad('invalid_steps', `Étape ${i + 1} : agent requis`);
    return { type, prompt, agentId: type === 'agent' ? String(s.agentId) : undefined } as Step;
  });
}
export async function listWorkflows(db: Db, userId: string) {
  need('workflows', 'Workflows');
  const rows = await db.query<any>(`SELECT id,name,steps,created_at FROM workflows WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
  return rows.map((r) => ({ ...r, steps: parseJson(r.steps, []) }));
}
export async function saveWorkflow(db: Db, userId: string, b: any, id?: string) {
  need('workflows', 'Workflows');
  const name = str(b.name, 'nom', { min: 2, max: 60 }), steps = validateSteps(b.steps), now = nowIso();
  if (id) {
    const r = await db.run(`UPDATE workflows SET name=$3, steps=$4, updated_at=$5 WHERE id=$1 AND user_id=$2`, [id, userId, name, JSON.stringify(steps), now]);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Workflow introuvable');
    return id;
  }
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workflows WHERE user_id=$1`, [userId]))?.n ?? 0;
  if (n >= 20) throw bad('workflows_full', 'Limite de 20 workflows atteinte');
  const nid = uid();
  await db.run(`INSERT INTO workflows (id,user_id,name,steps,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)`, [nid, userId, name, JSON.stringify(steps), now]);
  return nid;
}
export async function deleteWorkflow(db: Db, userId: string, id: string) {
  const r = await db.run(`DELETE FROM workflows WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Workflow introuvable');
}

/** Exécution séquentielle : chaque étape est une tâche facturée ; {{input}} et {{previous}} sont substitués. */
export async function runWorkflow(db: Db, user: UserRow, id: string, input: unknown) {
  need('workflows', 'Workflows');
  const wf = await db.get<any>(`SELECT id,name,steps FROM workflows WHERE id=$1 AND user_id=$2`, [id, user.id]);
  if (!wf) throw new HttpError(404, 'not_found', 'Workflow introuvable');
  const steps = parseJson<Step[]>(wf.steps, []);
  const inputText = str(input, 'entrée', { min: 1, max: 6000 });
  const runId = uid();
  await db.run(`INSERT INTO workflow_runs (id,workflow_id,user_id,status,input,created_at) VALUES ($1,$2,$3,'running',$4,$5)`, [runId, id, user.id, inputText.slice(0, 6000), nowIso()]);
  const log: { step: number; output?: string; error?: string }[] = [];
  let previous = inputText;
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const agent = s.type === 'agent' ? await loadAgent(db, user.id, s.agentId) : null;
      const text = s.prompt.replaceAll('{{input}}', inputText).replaceAll('{{previous}}', previous).slice(0, 8000);
      const { result } = await ask(db, user, { message: text, agent, kind: 'workflow_step' });
      previous = result.text;
      log.push({ step: i + 1, output: result.text.slice(0, 4000) });
    }
    await db.run(`UPDATE workflow_runs SET status='done', output=$2, log=$3, finished_at=$4 WHERE id=$1`, [runId, previous.slice(0, 8000), JSON.stringify(log), nowIso()]);
    return { runId, status: 'done', output: previous, log };
  } catch (e: any) {
    log.push({ step: log.length + 1, error: String(e?.message ?? e).slice(0, 300) });
    await db.run(`UPDATE workflow_runs SET status='failed', log=$2, finished_at=$3 WHERE id=$1`, [runId, JSON.stringify(log), nowIso()]);
    throw e;
  }
}
export async function listRuns(db: Db, userId: string, workflowId: string) {
  const rows = await db.query<any>(`SELECT id,status,input,output,log,created_at,finished_at FROM workflow_runs WHERE workflow_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 20`, [workflowId, userId]);
  return rows.map((r) => ({ ...r, log: parseJson(r.log, []) }));
}

// ----------------------------------------------------------------------------- marketplace (modérée)
export async function publishListing(db: Db, user: UserRow, b: { kind: unknown; refId: unknown; title: unknown; description: unknown }) {
  need('marketplace', 'Marketplace');
  if (!user.email_verified) throw forbidden('Vérifiez votre email avant de publier', 'email_unverified');
  const kind = String(b.kind);
  if (!['agent', 'workflow'].includes(kind)) throw bad('invalid_kind', 'Type : agent ou workflow');
  const n = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM marketplace_listings WHERE owner_id=$1`, [user.id]))?.n ?? 0;
  if (n >= 10) throw bad('listings_full', 'Limite de 10 publications atteinte');
  let payload: unknown;
  if (kind === 'agent') {
    const a = await db.get<any>(`SELECT name,description,system_prompt,use_memory,use_documents FROM agents WHERE id=$1 AND user_id=$2`, [String(b.refId), user.id]);
    if (!a) throw new HttpError(404, 'not_found', 'Agent introuvable');
    payload = { name: a.name, description: a.description, systemPrompt: a.system_prompt, useMemory: !!a.use_memory, useDocuments: !!a.use_documents };
  } else {
    const w = await db.get<any>(`SELECT name,steps FROM workflows WHERE id=$1 AND user_id=$2`, [String(b.refId), user.id]);
    if (!w) throw new HttpError(404, 'not_found', 'Workflow introuvable');
    const steps = parseJson<Step[]>(w.steps, []);
    if (steps.some((s) => s.type === 'agent')) throw bad('not_portable', 'Seuls les workflows composés d\'étapes « prompt » (sans agent personnel) peuvent être publiés');
    payload = { name: w.name, steps };
  }
  const id = uid();
  await db.run(`INSERT INTO marketplace_listings (id,owner_id,kind,title,description,payload,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
    [id, user.id, kind, str(b.title, 'titre', { min: 3, max: 80 }), str(b.description, 'description', { min: 10, max: 500 }), JSON.stringify(payload), nowIso()]);
  return id;
}
export async function browseListings(db: Db, q?: string) {
  need('marketplace', 'Marketplace');
  const rows = await db.query<any>(`SELECT id,kind,title,description,installs,created_at FROM marketplace_listings WHERE status='approved' ${q ? 'AND (lower(title) LIKE $1 OR lower(description) LIKE $1)' : ''} ORDER BY installs DESC, created_at DESC LIMIT 100`, q ? [`%${q.toLowerCase()}%`] : []);
  return rows;
}
export async function myListings(db: Db, userId: string) {
  return db.query<any>(`SELECT id,kind,title,status,installs,created_at FROM marketplace_listings WHERE owner_id=$1 ORDER BY created_at DESC`, [userId]);
}
export async function installListing(db: Db, user: UserRow, id: string) {
  need('marketplace', 'Marketplace');
  const l = await db.get<any>(`SELECT * FROM marketplace_listings WHERE id=$1 AND status='approved'`, [id]);
  if (!l) throw new HttpError(404, 'not_found', 'Annonce introuvable');
  const p = parseJson<any>(l.payload, {});
  let newId: string;
  if (l.kind === 'agent') newId = await saveAgent(db, user.id, { name: p.name, description: p.description, systemPrompt: p.systemPrompt, useMemory: p.useMemory, useDocuments: p.useDocuments });
  else newId = await saveWorkflow(db, user.id, { name: p.name, steps: p.steps });
  await db.run(`UPDATE marketplace_listings SET installs = installs + 1 WHERE id=$1`, [id]);
  return { kind: l.kind, id: newId };
}
export async function adminListings(db: Db, status = 'pending') {
  const rows = await db.query<any>(`SELECT l.id,l.kind,l.title,l.description,l.payload,l.status,l.created_at,u.email AS owner FROM marketplace_listings l LEFT JOIN users u ON u.id=l.owner_id WHERE l.status=$1 ORDER BY l.created_at DESC LIMIT 100`, [status]);
  return rows.map((r) => ({ ...r, payload: parseJson(r.payload, null) }));
}
export async function moderateListing(db: Db, adminId: string, id: string, decision: unknown) {
  if (!['approved', 'rejected'].includes(String(decision))) throw bad('invalid_decision', 'approved ou rejected');
  const r = await db.run(`UPDATE marketplace_listings SET status=$2, reviewed_by=$3, reviewed_at=$4 WHERE id=$1 AND status='pending'`, [id, String(decision), adminId, nowIso()]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Annonce introuvable ou déjà traitée');
  await audit(db, adminId, `listing_${decision}`, id);
}
