/**
 * /api/onboarding — initial scan via MCP servers + portrait.
 */
import { Router } from "express";
import { runOnboardingScan } from "../../L3_cognition/onboarding.js";
import { runOracleCouncil, getLatestPortrait } from "../../L3_cognition/system_agents/index.js";

const router = Router();

router.post("/scan", async (req, res) => {
  const sinceDays = req.body?.sinceDays ?? 14;
  try {
    const r = await runOnboardingScan({ sinceDays });
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/portrait", async (_req, res) => {
  try {
    const r = await runOracleCouncil();
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/portrait", (_req, res) => {
  const p = getLatestPortrait();
  if (!p) return res.status(404).json({ error: "no portrait yet" });
  res.json(p);
});

export default router;
