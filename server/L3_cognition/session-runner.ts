/**
 * L3 — Session Runner (Plan FSM).
 *
 * Walks an action_session's compiled steps in order. For each step:
 *   1. Pick tool (if step.tool given)
 *   2. Execute via L1 registry
 *   3. Mark step done | failed
 *   4. Continue or stop on first failure
 *
 * On full completion: bus.publish EXECUTION_DONE → Twin learns from results.
 */
import { db, DEFAULT_USER_ID } from "../L0_runtime/db.js";
import { executeTool } from "../L1_tools/registry.js";
import { bus } from "./bus.js";
import { nanoid } from "nanoid";

export async function startSession(sessionId: string): Promise<void> {
  const session = db.prepare("SELECT * FROM action_sessions WHERE id=? AND user_id=?").get(sessionId, DEFAULT_USER_ID) as any;
  if (!session) throw new Error(`session ${sessionId} not found`);
  db.prepare("UPDATE action_sessions SET status='running', started_at=datetime('now') WHERE id=?").run(sessionId);

  const steps = db.prepare("SELECT * FROM action_steps WHERE session_id=? ORDER BY step_index").all(sessionId) as any[];
  const stepsResult: { step: string; status: string; result: string }[] = [];
  const runId = nanoid();

  for (const step of steps) {
    db.prepare("UPDATE action_steps SET status='running', started_at=datetime('now') WHERE id=?").run(step.id);

    let outcome: { success: boolean; output: string; error?: string };
    if (step.tool) {
      const r = await executeTool(step.tool, {}, { runId, stepIndex: step.step_index });
      outcome = { success: r.success, output: r.output, error: r.error };
    } else {
      // No tool specified — treat the step as a "note" or manual action.
      // Mark complete with the step text as the result.
      outcome = { success: true, output: `(manual step) ${step.content}` };
    }

    db.prepare(
      "UPDATE action_steps SET status=?, result=?, error=?, finished_at=datetime('now') WHERE id=?"
    ).run(outcome.success ? "done" : "failed", outcome.output.slice(0, 2000), outcome.error ?? null, step.id);
    stepsResult.push({ step: step.content, status: outcome.success ? "done" : "failed", result: outcome.output });

    if (!outcome.success) {
      db.prepare("UPDATE action_sessions SET status='failed', finished_at=datetime('now') WHERE id=?").run(sessionId);
      bus.publish({ type: "EXECUTION_DONE", payload: { sessionId, steps_result: stepsResult, plan_summary: session.plan_summary } });
      return;
    }
  }

  db.prepare("UPDATE action_sessions SET status='done', finished_at=datetime('now') WHERE id=?").run(sessionId);
  bus.publish({ type: "EXECUTION_DONE", payload: { sessionId, steps_result: stepsResult, plan_summary: session.plan_summary } });
}
