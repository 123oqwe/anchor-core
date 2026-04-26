/**
 * L3 — Autonomous evolution sub-systems.
 *
 * Re-exports for the 7 ported mechanisms. Each lives in its own file with
 * focused logic. Callers (cron / dispatch / handlers / routes) import either
 * directly or via this index.
 *
 * The 8 evolution mechanisms (per anchor's architecture):
 *   1. Twin                  — L3_cognition/twin.ts (not in this dir)
 *   2. Dream                 — ./dream.ts                 ✅ ported
 *   3. GEPA                  — ./gepa.ts                  ✅ ported
 *   4. Personal Evolution    — ./evolution.ts             ✅ ported
 *   5. Skills crystallize    — ./skills.ts                ✅ ported
 *   6. Self-Diagnostic       — ./diagnostic.ts            ✅ ported
 *   7. Mutation eval gate    — TODO (gates Twin/GEPA/Evolution proposals)
 *   8. Workflow DAGs         — registered in dispatch.ts
 *
 * Oracle Council (portrait) — ./oracle-council.ts ✅ ported (not in 8 list,
 * but a separate user-facing wow during onboarding).
 */

export { runDream, type DreamStats } from "./dream.js";
export { runGEPA, type GEPAReport } from "./gepa.js";
export { runEvolution, getPromptAdaptations, type EvolutionResult } from "./evolution.js";
export { runSkillsCrystallize, type CrystallizeResult } from "./skills.js";
export { runDiagnostic, type DiagnosticReport } from "./diagnostic.js";
export { runOracleCouncil, getLatestPortrait, type PortraitV1, type OracleNarrative, type Compass } from "./oracle-council.js";
