/**
 * /api/tools — list registered tools, manually invoke a tool.
 */
import { Router } from "express";
import { getRegistryInfo, executeTool } from "../../L1_tools/registry.js";

const router = Router();

router.get("/", (_req, res) => res.json(getRegistryInfo()));

router.post("/:name/invoke", async (req, res) => {
  const input = req.body?.input ?? {};
  const result = await executeTool(req.params.name, input, undefined, "user_triggered");
  res.json(result);
});

export default router;
