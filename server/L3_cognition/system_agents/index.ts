/**
 * L3 — Autonomous evolution sub-systems.
 *
 * MVP: stubs that log + write skeleton outputs. Full algorithms live in
 * anchor-backend; ports happen Phase 2 of the migration. Each stub is
 * wire-compatible with its eventual implementation, so callers (cron /
 * dispatch / handlers) work today and don't change later.
 *
 * The 8 mechanisms (per anchor's architecture):
 *   1. Twin (already implemented in twin.ts — not stubbed)
 *   2. Dream (memory consolidation)
 *   3. GEPA (execution trace → prompt mutations)
 *   4. Evolution (long-running personalization)
 *   5. Skills (auto-crystallize repeated patterns)
 *   6. Diagnostic (system health)
 *   7. Mutation eval gate (gates Twin/GEPA/Evolution proposals)
 *   8. Workflow DAGs (registered in dispatch.ts)
 *
 * Oracle Council + Portrait Ceremony: also stubbed; full version generates
 * 5-narrative wow at onboarding end.
 */
import { db, DEFAULT_USER_ID, logExecution } from "../../L0_runtime/db.js";
import { writeMemory } from "../../L2_memory/memory.js";

// Dream Engine ported — see ./dream.ts.
export { runDream, type DreamStats } from "./dream.js";

export async function runGEPA(): Promise<{ proposals: number }> {
  // MVP: count failed agent_executions in last 7 days as a placeholder for trace-mining.
  const failures = (db.prepare(
    "SELECT COUNT(*) as c FROM agent_executions WHERE user_id=? AND status='failed' AND datetime(created_at) > datetime('now','-7 days')"
  ).get(DEFAULT_USER_ID) as any)?.c ?? 0;
  logExecution("GEPA", `${failures} failures in last 7d (full mutation proposals: Phase 2)`);
  return { proposals: 0 };
}

export async function runEvolution(): Promise<{ adaptations: number }> {
  // MVP: write a current-state summary to evolution_state; rich adaptive prompts come in Phase 2.
  const insightCount = (db.prepare("SELECT COUNT(*) as c FROM twin_insights WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  db.prepare(
    "INSERT INTO evolution_state (user_id, state_json, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json, updated_at=datetime('now')"
  ).run(DEFAULT_USER_ID, JSON.stringify({ twinInsights: insightCount, updatedAt: new Date().toISOString() }));
  return { adaptations: 0 };
}

export async function runSkillsCrystallize(): Promise<{ created: number }> {
  // MVP: counts confirmed plans with similar summaries; doesn't yet auto-create skills.
  const recent = db.prepare(
    "SELECT plan_summary, COUNT(*) as n FROM action_sessions WHERE user_id=? AND status='done' AND datetime(started_at) > datetime('now','-30 days') GROUP BY plan_summary HAVING n >= 3"
  ).all(DEFAULT_USER_ID) as any[];
  logExecution("Skills", `${recent.length} crystallization candidates (auto-create: Phase 2)`);
  return { created: 0 };
}

export async function runDiagnostic(): Promise<{ healthy: boolean; alerts: string[] }> {
  const alerts: string[] = [];
  const failureRate = (db.prepare(
    "SELECT (CAST(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0)) as r FROM agent_executions WHERE user_id=? AND datetime(created_at) > datetime('now','-1 day')"
  ).get(DEFAULT_USER_ID) as any)?.r ?? 0;
  if (failureRate > 0.3) alerts.push(`agent failure rate ${(failureRate * 100).toFixed(0)}% in last 24h`);
  const mcpErrors = (db.prepare("SELECT COUNT(*) as c FROM mcp_servers WHERE user_id=? AND status='error'").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (mcpErrors > 0) alerts.push(`${mcpErrors} MCP servers in error state`);
  return { healthy: alerts.length === 0, alerts };
}

// Oracle Council ported — see ./oracle-council.ts. Re-exported for callers.
export { runOracleCouncil, getLatestPortrait, type PortraitV1, type OracleNarrative, type Compass } from "./oracle-council.js";
