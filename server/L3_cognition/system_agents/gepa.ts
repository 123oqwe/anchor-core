/**
 * GEPA — port from anchor-backend (177 lines → ~110).
 *
 * Reads llm_calls + agent_executions traces, detects waste patterns, produces
 * optimization proposals. Anchor-backend wired this into a mutation-eval-gate
 * pipeline that auto-applies route overrides; we don't auto-apply yet — just
 * surface proposals for review.
 *
 * Inspired by Hermes Agent GEPA (ICLR 2026). Not a direct algorithmic port —
 * we use simple heuristics over llm_calls to keep this deterministic and
 * fast. Real GEPA-style prompt evolution can come when we have an eval set.
 *
 * Dropped (Karpathy):
 *   - proposeMutation pipeline + setRouteOverride auto-apply (eval gate not yet ported)
 *   - LLM-driven optimization synthesis (heuristic patterns are clearer + cheaper)
 *   - "Cognitive Swarm" pattern (no swarm in anchor-core)
 */
import { db, DEFAULT_USER_ID, logExecution } from "../../L0_runtime/db.js";

export type WasteType = "redundant_calls" | "excessive_tokens" | "failed_retries" | "slow_task" | "high_latency";

export interface WastePattern { type: WasteType; description: string; impact: string; count: number }
export interface Optimization { target: string; suggestion: string; estimatedSaving: string }

export interface GEPAReport {
  windowDays: number;
  totalCalls: number;
  totalTokens: number;
  failedCalls: number;
  efficiency: number;       // 0-100, higher = healthier
  wastePatterns: WastePattern[];
  optimizations: Optimization[];
}

export async function runGEPA(opts?: { daysBack?: number }): Promise<GEPAReport> {
  const daysBack = opts?.daysBack ?? 7;
  const calls = db.prepare(
    `SELECT task, model_id, input_tokens, output_tokens, latency_ms, status FROM llm_calls
     WHERE user_id=? AND datetime(created_at) > datetime('now', ?) ORDER BY created_at`
  ).all(DEFAULT_USER_ID, `-${daysBack} days`) as any[];

  const totalCalls = calls.length;
  const totalTokens = calls.reduce((s, c) => s + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0);
  const failedCalls = calls.filter(c => c.status === "failed").length;

  if (totalCalls < 5) {
    logExecution("GEPA", `${totalCalls} calls in last ${daysBack}d — insufficient signal`);
    return { windowDays: daysBack, totalCalls, totalTokens, failedCalls, efficiency: 100, wastePatterns: [], optimizations: [] };
  }

  const wastePatterns: WastePattern[] = [];
  const optimizations: Optimization[] = [];

  // Pattern 1: failed call rate
  if (failedCalls / totalCalls > 0.1) {
    const wastedTokens = calls.filter(c => c.status === "failed").reduce((s, c) => s + (c.input_tokens ?? 0), 0);
    wastePatterns.push({
      type: "failed_retries",
      description: `${failedCalls}/${totalCalls} calls failed (${Math.round(failedCalls / totalCalls * 100)}%)`,
      impact: `wasted ~${wastedTokens} input tokens`,
      count: failedCalls,
    });
  }

  // Per-task token + latency aggregation
  const taskAgg = new Map<string, { calls: number; tokens: number; latency: number; failed: number }>();
  for (const c of calls) {
    const e = taskAgg.get(c.task) ?? { calls: 0, tokens: 0, latency: 0, failed: 0 };
    e.calls++;
    e.tokens += (c.input_tokens ?? 0) + (c.output_tokens ?? 0);
    e.latency += c.latency_ms ?? 0;
    if (c.status === "failed") e.failed++;
    taskAgg.set(c.task, e);
  }

  // Pattern 2: excessive tokens per call (per task)
  for (const [task, agg] of taskAgg.entries()) {
    if (agg.calls < 3) continue;
    const avgTokens = agg.tokens / agg.calls;
    if (avgTokens > 3000) {
      wastePatterns.push({
        type: "excessive_tokens",
        description: `Task "${task}" averages ${Math.round(avgTokens)} tokens/call across ${agg.calls} calls`,
        impact: `consider trimming context injection or switching to a smaller model`,
        count: agg.calls,
      });
      optimizations.push({
        target: task,
        suggestion: `Trim context for "${task}" or route to a faster/cheaper model`,
        estimatedSaving: `~${Math.round((avgTokens - 1500) * agg.calls)} tokens/week`,
      });
    }
  }

  // Pattern 3: high-latency tasks
  for (const [task, agg] of taskAgg.entries()) {
    if (agg.calls < 3) continue;
    const avgLatency = agg.latency / agg.calls;
    if (avgLatency > 8000) {
      wastePatterns.push({
        type: "high_latency",
        description: `Task "${task}" averages ${Math.round(avgLatency)}ms latency (${agg.calls} calls)`,
        impact: `user-facing waits — consider streaming or smaller model`,
        count: agg.calls,
      });
    }
  }

  // Pattern 4: redundant identical calls (same task fired many times in a row — caching opportunity)
  const taskTopCalls = Array.from(taskAgg.entries()).sort((a, b) => b[1].calls - a[1].calls)[0];
  if (taskTopCalls && taskTopCalls[1].calls > totalCalls * 0.5) {
    wastePatterns.push({
      type: "redundant_calls",
      description: `Task "${taskTopCalls[0]}" accounts for ${Math.round(taskTopCalls[1].calls / totalCalls * 100)}% of all LLM calls`,
      impact: `consider caching or dedup — single task dominating call volume`,
      count: taskTopCalls[1].calls,
    });
  }

  // Efficiency score: 100 minus penalty per waste pattern + failure rate
  const efficiency = Math.max(0, 100 - wastePatterns.length * 12 - Math.round(failedCalls / totalCalls * 100));

  logExecution("GEPA", `${totalCalls} calls, ${totalTokens} tokens, ${wastePatterns.length} waste patterns, eff=${efficiency}`);
  return { windowDays: daysBack, totalCalls, totalTokens, failedCalls, efficiency, wastePatterns, optimizations };
}
