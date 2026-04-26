/**
 * /api/mcp — MCP server registration + connect/disconnect.
 *
 * Add servers like:
 *   POST /api/mcp { name: "apple-mcp", command: "npx", args: ["-y","@dhravya/apple-mcp"] }
 *   POST /api/mcp/:id/connect
 */
import { Router } from "express";
import { listServers, getServer, createServer, deleteServer, connectServer, disconnectServer } from "../../L0_runtime/mcp-host.js";

const router = Router();

router.get("/", (_req, res) => res.json(listServers()));

router.post("/", (req, res) => {
  const { name, command, args, env, enabled } = req.body ?? {};
  if (!name || !command) return res.status(400).json({ error: "name + command required" });
  const cfg = createServer({ name, command, args, env, enabled });
  res.json(cfg);
});

router.get("/:id", (req, res) => {
  const s = getServer(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

router.delete("/:id", (req, res) => {
  res.json({ ok: deleteServer(req.params.id) });
});

router.post("/:id/connect", async (req, res) => {
  const r = await connectServer(req.params.id);
  res.json(r);
});

router.post("/:id/disconnect", (req, res) => {
  disconnectServer(req.params.id);
  res.json({ ok: true });
});

export default router;
