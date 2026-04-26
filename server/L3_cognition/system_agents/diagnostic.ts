/**
 * Self-Diagnostic — port from anchor-backend (258 lines → ~140).
 *
 * Pure SQL + math. Zero LLM calls. Cannot fail due to LLM outage.
 *
 * 9 health checks adapted to anchor-core's schema. Severity-sorted alerts.
 *
 * Dropped from backend (Simplicity First):
 *   - system_config / setConfig auto-fix layer (no config table yet)
 *   - diagnostic_reports persistence (return snapshot; add table if trending needed)
 *   - llm_calls cost tracking (no llm_calls table yet)
 *   - messages table reads (no chat persistence yet)
 *   - activity_captures (no native activity in anchor-core)
 *   - phase determination by data volume (use simpler "baseline" flag)
 */
import { db, DEFAULT_USER_ID, logExecution } from "../../L0_runtime/db.js";

const MAX_MEMORIES = 200;

interface DiagnosticAlert {
  severity: "critical" | "warning" | "info";
  check: string;
  message: string;
}

export interface DiagnosticReport {
  baseline: boolean;
  // Snapshot counts
  twinInsights: number;
  memoryCount: number;
  graphNodeCount: number;
  graphOrphanRatio: number;  // % of nodes with no edges
  mcpServers: { connected: number; error: number; total: number };
  skillsCount: number;
  customAgentsCount: number;
  pendingApprovals: number;
  agentFailureRate24h: number;  // 0.0-1.0
  evolutionStateDaysOld: number | null;
  alerts: DiagnosticAlert[];
}

function isBaseline(): boolean {
  // Treat first 14 days from oldest record as baseline (suppress non-critical alerts)
  const oldest = db.prepare(
    "SELECT MIN(created_at) as o FROM agent_executions WHERE user_id=?"
  ).get(DEFAULT_USER_ID) as any;
  if (!oldest?.o) return true;
  const days = (Date.now() - new Date(oldest.o).getTime()) / 86400000;
  return days < 14;
}

export function runDiagnostic(): DiagnosticReport {
  const alerts: DiagnosticAlert[] = [];
  const baseline = isBaseline();

  // Q1: Twin learning
  const twinInsights = (db.prepare("SELECT COUNT(*) as c FROM twin_insights WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const lastInsight = db.prepare("SELECT MAX(created_at) as last FROM twin_insights WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  const insightDaysAgo = lastInsight?.last ? (Date.now() - new Date(lastInsight.last).getTime()) / 86400000 : 999;
  const sessionCount = (db.prepare("SELECT COUNT(*) as c FROM action_sessions WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (!baseline && sessionCount > 5 && twinInsights === 0) {
    alerts.push({ severity: "warning", check: "TWIN", message: "Twin has 0 insights despite >5 sessions — learning pipeline may be stalled" });
  } else if (!baseline && twinInsights > 0 && insightDaysAgo > 14) {
    alerts.push({ severity: "info", check: "TWIN", message: `Twin's last insight was ${Math.round(insightDaysAgo)} days ago` });
  }

  // Q2: Memory capacity
  const memoryCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (memoryCount > MAX_MEMORIES * 0.95) {
    alerts.push({ severity: "critical", check: "MEMORY_CAPACITY", message: `Memory at ${memoryCount}/${MAX_MEMORIES} (${Math.round(memoryCount / MAX_MEMORIES * 100)}%) — Dream should prune` });
  } else if (memoryCount > MAX_MEMORIES * 0.75) {
    alerts.push({ severity: "warning", check: "MEMORY_CAPACITY", message: `Memory at ${memoryCount}/${MAX_MEMORIES}` });
  }

  // Q3: Graph orphans (nodes with no edges → low connectivity)
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM graph_nodes WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const orphanCount = (db.prepare(
    "SELECT COUNT(*) as c FROM graph_nodes n WHERE n.user_id=? AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.from_node_id=n.id OR e.to_node_id=n.id)"
  ).get(DEFAULT_USER_ID) as any)?.c ?? 0;
  const orphanRatio = totalNodes > 0 ? Math.round((orphanCount / totalNodes) * 100) : 0;
  if (!baseline && totalNodes > 20 && orphanRatio > 70) {
    alerts.push({ severity: "warning", check: "GRAPH_ORPHANS", message: `${orphanRatio}% orphan nodes (${orphanCount}/${totalNodes}) — extractor may not be linking related entities` });
  }

  // Q4: MCP server health
  const mcpRows = db.prepare("SELECT status FROM mcp_servers WHERE user_id=?").all(DEFAULT_USER_ID) as any[];
  const mcpConnected = mcpRows.filter(r => r.status === "connected").length;
  const mcpError = mcpRows.filter(r => r.status === "error").length;
  if (mcpError > 0) {
    alerts.push({ severity: "critical", check: "MCP_HEALTH", message: `${mcpError} MCP server(s) in error state — capabilities will be missing` });
  }

  // Q5: Skills count (informational)
  const skillsCount = (db.prepare("SELECT COUNT(*) as c FROM skills WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  // Q6: Custom agents (informational)
  const customAgentsCount = (db.prepare("SELECT COUNT(*) as c FROM user_agents WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;

  // Q7: Approval backlog
  const pendingApprovals = (db.prepare("SELECT COUNT(*) as c FROM approval_queue WHERE user_id=? AND status='pending'").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (pendingApprovals > 20) {
    alerts.push({ severity: "warning", check: "APPROVAL_BACKLOG", message: `${pendingApprovals} approvals pending — user may be overwhelmed by gate prompts` });
  }

  // Q8: Agent failure rate (last 24h)
  const fr = db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM agent_executions WHERE user_id=? AND datetime(created_at) > datetime('now','-1 day')"
  ).get(DEFAULT_USER_ID) as any;
  const total24h = fr?.total ?? 0;
  const failed24h = fr?.failed ?? 0;
  const failureRate = total24h > 0 ? failed24h / total24h : 0;
  if (!baseline && total24h >= 10 && failureRate > 0.3) {
    alerts.push({ severity: "critical", check: "AGENT_FAILURE_RATE", message: `${Math.round(failureRate * 100)}% agent failure rate in last 24h (${failed24h}/${total24h})` });
  } else if (!baseline && total24h >= 5 && failureRate > 0.15) {
    alerts.push({ severity: "warning", check: "AGENT_FAILURE_RATE", message: `${Math.round(failureRate * 100)}% agent failure rate in last 24h` });
  }

  // Q9: Evolution state freshness
  const ev = db.prepare("SELECT updated_at FROM evolution_state WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  const evolutionStateDaysOld = ev?.updated_at ? Math.round((Date.now() - new Date(ev.updated_at).getTime()) / 86400000) : null;
  if (!baseline && evolutionStateDaysOld !== null && evolutionStateDaysOld > 7) {
    alerts.push({ severity: "info", check: "EVOLUTION_STALE", message: `evolution_state hasn't updated in ${evolutionStateDaysOld} days` });
  }

  // Sort alerts: critical → warning → info
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);

  const report: DiagnosticReport = {
    baseline,
    twinInsights,
    memoryCount,
    graphNodeCount: totalNodes,
    graphOrphanRatio: orphanRatio,
    mcpServers: { connected: mcpConnected, error: mcpError, total: mcpRows.length },
    skillsCount,
    customAgentsCount,
    pendingApprovals,
    agentFailureRate24h: Math.round(failureRate * 100) / 100,
    evolutionStateDaysOld,
    alerts,
  };

  const counts = { critical: alerts.filter(a => a.severity === "critical").length, warning: alerts.filter(a => a.severity === "warning").length };
  logExecution("Diagnostic", `${counts.critical} critical, ${counts.warning} warning${baseline ? " (baseline)" : ""}`);
  return report;
}
