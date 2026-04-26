/**
 * /api/system — manual triggers + introspection for evolution subsystems.
 *
 * In production these run on cron. Endpoints exist so user (or tests) can
 * fire them on-demand.
 */
import { Router } from "express";
import { runDream } from "../../L3_cognition/system_agents/dream.js";
import { runDiagnostic } from "../../L3_cognition/system_agents/diagnostic.js";
import { runSkillsCrystallize } from "../../L3_cognition/system_agents/skills.js";
import { runEvolution, getPromptAdaptations } from "../../L3_cognition/system_agents/evolution.js";

const router = Router();

router.post("/dream/run", async (_req, res) => {
  try { res.json(await runDream()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/diagnostic", (_req, res) => {
  try { res.json(runDiagnostic()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/skills/crystallize", async (_req, res) => {
  try { res.json(await runSkillsCrystallize()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/evolution/run", async (_req, res) => {
  try { res.json(await runEvolution()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get("/evolution/adaptations", (_req, res) => {
  res.json({ adaptations: getPromptAdaptations() });
});

export default router;
