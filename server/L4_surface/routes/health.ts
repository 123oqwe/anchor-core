import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../../L0_runtime/db.js";
import { getAllTools } from "../../L1_tools/registry.js";
import { listServers } from "../../L0_runtime/mcp-host.js";

const router = Router();

router.get("/", (_req, res) => {
  const counts = {
    nodes: (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any).c,
    memories: (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any).c,
    twinInsights: (db.prepare("SELECT COUNT(*) as c FROM twin_insights WHERE user_id=?").get(DEFAULT_USER_ID) as any).c,
    projects: (db.prepare("SELECT COUNT(*) as c FROM projects WHERE user_id=?").get(DEFAULT_USER_ID) as any).c,
    tasks: (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE user_id=?").get(DEFAULT_USER_ID) as any).c,
    customAgents: (db.prepare("SELECT COUNT(*) as c FROM user_agents WHERE user_id=?").get(DEFAULT_USER_ID) as any).c,
  };
  const mcpServers = listServers();
  res.json({
    status: "ok",
    version: "0.1.0",
    platform: process.platform,
    counts,
    tools: { total: getAllTools().length, mcp: mcpServers.reduce((s, m) => s + m.tools.length, 0) },
    mcpServers: mcpServers.map(m => ({ name: m.name, status: m.status, tools: m.tools.length })),
  });
});

export default router;
