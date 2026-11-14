import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { logEvent } from './security.js';
import { notifyOwner } from './notify.js';
import type { BudgetGuard } from './llm.js';

// ----------------------------------------------------------------------------- coupe-circuit de dépense API (§1.3)
// Plafonne la consommation quotidienne cumulée (tous utilisateurs, tous fournisseurs d'IA confondus) en JETONS —
// l'unité que chaque fournisseur renvoie réellement, donc vérifiable, par opposition à un montant en dollars que ce
// serveur devrait inventer sans connaître le tarif négocié par l'exploitant. Au-delà du plafond, les nouveaux appels
// basculent automatiquement vers le fournisseur local de démonstration jusqu'au lendemain (voir llm.ts, llmChat()).

interface DayUsage { tokens: number; costUsd: number }

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const usageKey = (d: string) => `ai_usage:${d}`;
const alertKey = (d: string) => `ai_budget_alert:${d}`;

async function readUsage(db: Db, d: string): Promise<DayUsage> {
  const row = await db.get<{ value: string }>(`SELECT value FROM settings WHERE key=$1`, [usageKey(d)]);
  if (!row) return { tokens: 0, costUsd: 0 };
  try {
    const v = JSON.parse(row.value);
    return { tokens: Number(v.tokens) || 0, costUsd: Number(v.costUsd) || 0 };
  } catch { return { tokens: 0, costUsd: 0 }; }
}

/** Lecture seule, pour l'affichage admin (ex. tableau de bord d'exploitation). */
export async function todayUsage(db: Db): Promise<DayUsage & { budget: number }> {
  const u = await readUsage(db, day());
  return { ...u, budget: config.ai.dailyTokenBudget };
}

export function createDbBudgetGuard(db: Db): BudgetGuard {
  return {
    async allow() {
      if (!config.ai.dailyTokenBudget) return true; // coupe-circuit désactivé (AI_DAILY_TOKEN_BUDGET=0)
      const u = await readUsage(db, day());
      return u.tokens < config.ai.dailyTokenBudget;
    },
    async record(provider, tokensIn, tokensOut) {
      if (!config.ai.dailyTokenBudget && !Object.values(config.ai.costPerMTokUsd).some(Boolean)) return;
      const d = day();
      const u = await readUsage(db, d);
      const addedTokens = Math.max(0, tokensIn) + Math.max(0, tokensOut);
      const rate = (config.ai.costPerMTokUsd as Record<string, number>)[provider] ?? 0;
      const next: DayUsage = { tokens: u.tokens + addedTokens, costUsd: u.costUsd + (addedTokens / 1_000_000) * rate };
      await db.run(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [usageKey(d), JSON.stringify(next)]);
      if (config.ai.dailyTokenBudget && next.tokens >= config.ai.dailyTokenBudget) {
        const already = await db.get(`SELECT 1 AS x FROM settings WHERE key=$1`, [alertKey(d)]);
        if (!already) {
          await db.run(`INSERT INTO settings (key,value) VALUES ($1,'1') ON CONFLICT (key) DO NOTHING`, [alertKey(d)]);
          await logEvent(db, 'ai_budget_exceeded', 'high', { detail: { tokens: next.tokens, budget: config.ai.dailyTokenBudget, costUsd: next.costUsd } });
          const costLine = next.costUsd > 0 ? ` (≈ ${next.costUsd.toFixed(2)} $ au tarif renseigné)` : '';
          await notifyOwner(
            db,
            'Budget IA quotidien atteint',
            `Le plafond quotidien de jetons IA est atteint : ${next.tokens.toLocaleString('fr-FR')} / ${config.ai.dailyTokenBudget.toLocaleString('fr-FR')} jetons${costLine}. ` +
              `Les nouvelles conversations basculent en mode démonstration jusqu'à minuit (UTC). Ajustez AI_DAILY_TOKEN_BUDGET si besoin.`,
          );
        }
      }
    },
  };
}
