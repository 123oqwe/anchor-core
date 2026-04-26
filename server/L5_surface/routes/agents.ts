/**
 * /api/agents — Custom Agent CRUD + run.
 */
import { Router } from "express";
import { listCustomAgents, createCustomAgent, deleteCustomAgent, runCustomAgent, getCustomAgent } from "../../L3_cognition/custom-agent.js";

const router = Router();

router.get("/", (_req, res) => res.json(listCustomAgents()));

router.post("/", (req, res) => {
  const { name, instructions, tools, triggerType } = req.body ?? {};
  if (!name || !instructions) return res.status(400).json({ error: "name + instructions required" });
  const agent = createCustomAgent({ name, instructions, tools, triggerType });
  res.json(agent);
});

router.get("/:id", (req, res) => {
  const a = getCustomAgent(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(a);
});

router.delete("/:id", (req, res) => {
  const ok = deleteCustomAgent(req.params.id);
  res.json({ ok });
});

router.post("/:id/run", async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const result = await runCustomAgent(req.params.id, message);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
