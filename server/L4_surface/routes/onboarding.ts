/**
 * /api/onboarding — initial scan via MCP servers + portrait.
 */
import { Router } from "express";
import { runOnboardingScan } from "../../L3_cognition/onboarding.js";
import { runOraclePortraitStub } from "../../L3_cognition/system_agents/index.js";

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
    const r = await runOraclePortraitStub();
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
