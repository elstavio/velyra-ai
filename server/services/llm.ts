import { config } from '../config.js';
import { HttpError } from '../lib/util.js';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }
export interface LlmResult { text: string; provider: string; model: string; tokensIn?: number; tokensOut?: number }

export interface LlmOptions { model?: string; maxOutputTokens?: number }
interface Provider { id: string; configured(): boolean; model(): string; call(msgs: ChatMsg[], o?: LlmOptions): Promise<Omit<LlmResult, 'provider'>> }

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let j: any; try { j = JSON.parse(text); } catch { throw new Error(`réponse non JSON (HTTP ${r.status})`); }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(j?.error?.message ?? j?.message ?? text).slice(0, 200)}`);
  return j;
}

/** Les rôles doivent alterner en commençant par « user » ; on fusionne les messages consécutifs de même rôle. */
function alternate(msgs: ChatMsg[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const anthropic: Provider = {
  id: 'anthropic', configured: () => !!config.ai.anthropic.key && !!config.ai.anthropic.model, model: () => config.ai.anthropic.model,
  async call(msgs, o) {
    const c = config.ai.anthropic;
    // POST /v1/messages ; en-têtes x-api-key + anthropic-version (API Messages d'Anthropic)
    const j = await post(`${c.base}/v1/messages`, { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
      { model: o?.model ?? c.model, max_tokens: o?.maxOutputTokens ?? config.ai.maxOutputTokens, system: msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined, messages: alternate(msgs) });
    const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return { text, model: j.model ?? c.model, tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens };
  },
};

const chatCompletions = (id: 'mistral'): Provider => ({
  id, configured: () => !!config.ai[id].key && !!config.ai[id].model, model: () => config.ai[id].model,
  async call(msgs, o) {
    const c = config.ai[id];
    // POST {base}/chat/completions, Authorization: Bearer — réponse choices[0].message.content, usage.{prompt,completion}_tokens
    const j = await post(`${c.base}/chat/completions`, { authorization: `Bearer ${c.key}` },
      { model: o?.model ?? c.model, messages: [...msgs.filter((m) => m.role === 'system'), ...alternate(msgs)], max_tokens: o?.maxOutputTokens ?? config.ai.maxOutputTokens });
    return { text: String(j.choices?.[0]?.message?.content ?? ''), model: j.model ?? c.model, tokensIn: j.usage?.prompt_tokens, tokensOut: j.usage?.completion_tokens };
  },
});

/**
 * OpenAI via l'API « Responses » (recommandée par OpenAI pour la génération de texte) :
 * POST {base}/responses { model, instructions, input:[{role,content}], max_output_tokens } ;
 * le texte se lit dans output[] (items type « message » → parties « output_text ») ; usage.{input,output}_tokens.
 * max_output_tokens inclut les jetons de raisonnement : on garde une marge pour ne pas obtenir une réponse vide.
 */
export const openai: Provider = {
  id: 'openai', configured: () => !!config.ai.openai.key && !!config.ai.openai.model, model: () => config.ai.openai.model,
  async call(msgs, o) {
    const c = config.ai.openai;
    const j = await post(`${c.base}/responses`, { authorization: `Bearer ${c.key}` }, {
      model: o?.model ?? c.model,
      instructions: msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined,
      input: alternate(msgs),
      max_output_tokens: Math.max(o?.maxOutputTokens ?? config.ai.maxOutputTokens, 2000),
      store: false, // pas de conservation des échanges côté OpenAI au-delà des obligations légales du fournisseur
    });
    const text = (j.output ?? []).filter((it: any) => it.type === 'message').flatMap((it: any) => it.content ?? []).filter((p: any) => p.type === 'output_text').map((p: any) => p.text).join('');
    if (!text.trim() && j.status === 'incomplete') throw new Error(`réponse incomplète (${j.incomplete_details?.reason ?? 'inconnue'})`);
    return { text, model: j.model ?? c.model, tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens };
  },
};

/** Fournisseur local de démonstration : aucune IA, aucun appel réseau. Désactivé en production. */
export const localProvider: Provider = {
  id: 'local', configured: () => config.allowMock, model: () => 'local-demo',
  async call(msgs) {
    const last = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    return { text: `[Mode démonstration — aucun modèle d'IA connecté] Vous avez écrit : « ${last.slice(0, 300)} »`, model: 'local-demo', tokensIn: 0, tokensOut: 0 };
  },
};

const REGISTRY: Provider[] = [anthropic, openai, chatCompletions('mistral'), localProvider];
let override: Provider[] | null = null;
export const providerIds = () => (override ?? REGISTRY).filter((p) => p.configured()).map((p) => p.id);
export const _setProvidersForTests = (p: Provider[] | null) => { override = p; };

/** Coupe-circuit de dépense (voir services/aibudget.ts), branché par app.ts. Optionnel : si jamais câblé, aucune limite. */
export interface BudgetGuard { allow(): Promise<boolean>; record(provider: string, tokensIn: number, tokensOut: number): Promise<void> }
let budgetGuard: BudgetGuard | null = null;
export const setBudgetGuard = (g: BudgetGuard | null) => { budgetGuard = g; };

/** Routeur de modèles : fournisseur demandé, puis fournisseur par défaut, puis les autres ; repli automatique en cas d'erreur. */
export async function llmChat(msgs: ChatMsg[], preferred?: string | null, opts?: LlmOptions): Promise<LlmResult> {
  const all = (override ?? REGISTRY).filter((p) => p.configured());
  const order = [...all].sort((a, b) => rank(a) - rank(b));
  function rank(p: Provider) { return p.id === preferred ? 0 : p.id === config.ai.defaultProvider ? 1 : p.id === 'local' ? 99 : 2; }
  if (!order.length) throw new HttpError(503, 'ai_unavailable', "Aucun fournisseur d'IA n'est configuré sur ce serveur.");

  // Budget quotidien dépassé : on ne sollicite plus aucun fournisseur payant, on répond honnêtement en mode démonstration.
  if (budgetGuard && !(await budgetGuard.allow())) {
    const local = order.find((p) => p.id === 'local') ?? localProvider;
    const r = await local.call(msgs, opts);
    return { ...r, provider: local.id, text: `[Budget IA quotidien atteint — réponse en mode démonstration] ${r.text}` };
  }

  let lastErr = '';
  for (const p of order) {
    try {
      const r = await p.call(msgs, p.id === preferred ? opts : { ...opts, model: undefined } /* un nom de modèle n'a de sens que pour son fournisseur */);
      if (!r.text.trim()) throw new Error('réponse vide');
      if (budgetGuard && p.id !== 'local') void budgetGuard.record(p.id, r.tokensIn ?? 0, r.tokensOut ?? 0).catch(() => undefined);
      return { ...r, provider: p.id };
    } catch (e: any) { lastErr = `${p.id}: ${String(e?.message ?? e)}`; }
  }
  throw new HttpError(502, 'ai_failed', `Le service d'IA est momentanément indisponible. (${lastErr.slice(0, 120)})`);
}
