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

// Personal Evolution ported — see ./evolution.ts.
export { runEvolution, getPromptAdaptations, type EvolutionResult } from "./evolution.js";

// Skills Crystallization ported — see ./skills.ts.
export { runSkillsCrystallize, type CrystallizeResult } from "./skills.js";

// Diagnostic ported — see ./diagnostic.ts.
export { runDiagnostic, type DiagnosticReport } from "./diagnostic.js";

// Oracle Council ported — see ./oracle-council.ts. Re-exported for callers.
export { runOracleCouncil, getLatestPortrait, type PortraitV1, type OracleNarrative, type Compass } from "./oracle-council.js";
