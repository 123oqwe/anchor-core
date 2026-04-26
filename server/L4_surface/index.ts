/**
 * L4 Surface — HTTP entry point.
 *
 * Boot order:
 *   1. L0: db schema runs on import
 *   2. L1: register builtin tools
 *   3. L0: connect MCP servers (registers their tools into L1)
 *   4. L3: wire bus handlers, register system schedules
 *   5. L4: mount routes, listen
 */
import express, { type Request, type Response } from "express";
import { registerBuiltinTools } from "../L1_tools/builtin/index.js";
import { initMCPHost } from "../L0_runtime/mcp-host.js";
import { wireHandlers } from "../L3_cognition/handlers.js";
import { registerSystemSchedules } from "../L3_cognition/dispatch.js";
import healthRoutes from "./routes/health.js";
import advisorRoutes from "./routes/advisor.js";
import agentRoutes from "./routes/agents.js";
import projectRoutes from "./routes/projects.js";
import taskRoutes from "./routes/tasks.js";
import memoryRoutes from "./routes/memory.js";
import mcpRoutes from "./routes/mcp.js";
import cronRoutes from "./routes/cron.js";
import onboardingRoutes from "./routes/onboarding.js";
import chatRoutes from "./routes/chat.js";
import approvalRoutes from "./routes/approvals.js";
import toolRoutes from "./routes/tools.js";
import systemRoutes from "./routes/system.js";

async function boot(): Promise<void> {
  console.log("⚓ Anchor Core booting...");

  // L1: builtin tools
  registerBuiltinTools();

  // L0: MCP host (auto-connects enabled servers, registers their tools)
  await initMCPHost();

  // L3: event handlers + scheduler
  wireHandlers();
  registerSystemSchedules();

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });

  app.use("/health", healthRoutes);
  app.use("/api/advisor", advisorRoutes);
  app.use("/api/agents", agentRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/tasks", taskRoutes);
  app.use("/api/memory", memoryRoutes);
  app.use("/api/mcp", mcpRoutes);
  app.use("/api/cron", cronRoutes);
  app.use("/api/onboarding", onboardingRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/approvals", approvalRoutes);
  app.use("/api/tools", toolRoutes);
  app.use("/api/system", systemRoutes);

  app.use((err: any, _req: Request, res: Response, _next: any) => {
    console.error("[Express] error:", err);
    res.status(500).json({ error: err?.message ?? "unknown" });
  });

  const port = parseInt(process.env.PORT ?? "3010", 10);
  app.listen(port, () => {
    console.log(`⚓ Anchor Core ready at http://localhost:${port}`);
    console.log(`   Try: curl http://localhost:${port}/health`);
  });
}

boot().catch(err => { console.error("Boot failed:", err); process.exit(1); });
