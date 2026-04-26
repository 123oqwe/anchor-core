/**
 * /api/advisor — Decision Agent endpoints.
 *
 * POST /        → run Decision Agent on user message
 * POST /confirm → user accepts a plan (with possible edits) → starts session via bus
 */
import { Router } from "express";
import { decide, persistPlanAsSession } from "../../L3_cognition/decision.js";
import { bus, type StepChange, type PlanStep } from "../../L3_cognition/bus.js";

const router = Router();

router.post("/", async (req, res) => {
  const { message, history } = req.body ?? {};
  if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });
  try {
    const result = await decide(message, history);
    if (result.isPlan && result.plan) {
      const sessionId = persistPlanAsSession(message, result.plan);
      res.json({ ...result, sessionId });
    } else {
      res.json(result);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/confirm", (req, res) => {
  const { sessionId, original_steps, user_steps, changes } = req.body ?? {};
  if (!sessionId || !Array.isArray(user_steps)) {
    return res.status(400).json({ error: "sessionId + user_steps required" });
  }
  bus.publish({
    type: "USER_CONFIRMED",
    payload: {
      sessionId,
      original_steps: (original_steps ?? []) as PlanStep[],
      user_steps: user_steps as PlanStep[],
      changes: (changes ?? []) as StepChange[],
    },
  });
  res.json({ ok: true, sessionId });
});

export default router;
