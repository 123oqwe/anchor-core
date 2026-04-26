/**
 * Personal Evolution — port from anchor-backend (388 lines → ~80).
 *
 * The "system gets smarter without being told" loop.
 *
 * What backend did:
 *   capture 24h signals → analyze deviation → detect stable patterns →
 *   update 5 dimensions (decision_style / plan_complexity / tone / domain_weights /
 *   time_preference) → emit prompt adaptations injected into Decision Agent.
 *
 * What we port (Karpathy Simplicity First):
 *   capture last-30d twin insights + session outcomes → distill into a single
 *   `prompt_adaptations` string → write to evolution_state.state_json →
 *   getPromptAdaptations() lets decision.ts inject it.
 *
 * Dropped:
 *   - 5 dimension tracking + previous_value diffing (over-engineered for N=1)
 *   - satisfaction_signals reads (no table in anchor-core)
 *   - LLM-driven dimension inference (deterministic distillation is enough)
 */
import { db, DEFAULT_USER_ID, logExecution } from "../../L0_runtime/db.js";
import { getTwinInsights } from "../../L2_memory/memory.js";

export interface EvolutionResult {
  adaptationsCount: number;
  contraindications: number;
  preferences: number;
  failureRate: number;
}

export async function runEvolution(): Promise<EvolutionResult> {
  const twinInsights = getTwinInsights(50);
  const contraindications = twinInsights.filter(i => i.contraindication).slice(0, 8);
  const preferences = twinInsights.filter(i => !i.contraindication && i.confidence > 0.7).slice(0, 8);

  const sessions = db.prepare(
    "SELECT status, COUNT(*) as n FROM action_sessions WHERE user_id=? AND datetime(started_at) > datetime('now','-30 days') GROUP BY status"
  ).all(DEFAULT_USER_ID) as any[];
  const total = sessions.reduce((s, r) => s + r.n, 0);
  const failed = sessions.find(r => r.status === "failed")?.n ?? 0;
  const failureRate = total > 0 ? failed / total : 0;

  const adaptations: string[] = [];
  if (contraindications.length) {
    adaptations.push(
      "USER CONTRAINDICATIONS (NEVER suggest these — Twin learned from edits):\n" +
      contraindications.map(c => `  - ${c.contraindication}`).join("\n"),
    );
  }
  if (preferences.length) {
    adaptations.push(
      "OBSERVED PREFERENCES (high-confidence Twin insights):\n" +
      preferences.map(p => `  - [${p.category}, conf ${p.confidence}] ${p.insight}`).join("\n"),
    );
  }
  if (total >= 5 && failureRate > 0.3) {
    adaptations.push(
      `SYSTEM NOTE: recent plans have ${Math.round(failureRate * 100)}% failure rate (${failed}/${total} in last 30 days). ` +
      "Be more conservative in step decomposition; favor simpler / verifiable steps.",
    );
  }

  const state = {
    adaptations,
    summary: { twinInsights: twinInsights.length, contraindications: contraindications.length, preferences: preferences.length, failureRate },
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO evolution_state (user_id, state_json, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json, updated_at=datetime('now')"
  ).run(DEFAULT_USER_ID, JSON.stringify(state));

  logExecution("Evolution", `${adaptations.length} adaptations (${contraindications.length} contraindications, ${preferences.length} preferences, ${Math.round(failureRate * 100)}% fail)`);
  return { adaptationsCount: adaptations.length, contraindications: contraindications.length, preferences: preferences.length, failureRate };
}

/** Decision Agent calls this to get the latest prompt adaptations as a string. */
export function getPromptAdaptations(): string {
  const row = db.prepare("SELECT state_json FROM evolution_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  if (!row) return "";
  try {
    const s = JSON.parse(row.state_json);
    if (Array.isArray(s.adaptations) && s.adaptations.length) return s.adaptations.join("\n\n");
    return "";
  } catch {
    return "";
  }
}
