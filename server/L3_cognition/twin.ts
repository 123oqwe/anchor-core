/**
 * L3 — Twin Agent.
 *
 * Continuously learns the user from:
 *   1. Edits to advisor's plan (USER_CONFIRMED.changes)
 *   2. Execution outcomes (EXECUTION_DONE.steps_result)
 *   3. (later) accept/reject patterns + retrospective
 *
 * Outputs: behavioral insights + contraindications → L2 twin_insights table.
 * Decision Agent reads them next turn.
 */
import { text } from "../L0_runtime/llm-gateway.js";
import { writeTwinInsight } from "../L2_memory/memory.js";
import { createNode } from "../L2_memory/graph.js";
import type { StepChange } from "../L4_orchestration/bus.js";

const SYS_EDITS = `You are Anchor's Twin Agent. The user just edited an advisor plan. From the diff, infer ONE thing about the user's preferences, working style, or constraints.
Output JSON only:
{"category":"<short category>","insight":"<one sentence>","confidence":0.0-1.0,"contraindication":"<thing system should AVOID suggesting next time, or null>"}
Example: user always deletes "schedule a call" → contraindication: "Do not suggest phone calls"`;

const SYS_RESULTS = `You are Anchor's Twin Agent. A plan finished executing. From the steps + results, infer whether the system's suggestions are landing or missing.
Output JSON only:
{"category":"<category>","insight":"<one sentence>","confidence":0.0-1.0,"contraindication":"<or null>"}`;

export async function twinLearnFromEdits(changes: StepChange[]): Promise<void> {
  const meaningful = changes.filter(c => c.type !== "kept");
  if (!meaningful.length) return;

  const summary = meaningful.map(c => {
    if (c.type === "deleted") return `DELETED: "${c.before}"`;
    if (c.type === "added") return `ADDED: "${c.content}"`;
    if (c.type === "modified") return `CHANGED: "${c.before}" → "${c.after}"`;
    return "";
  }).filter(Boolean).join("\n");

  try {
    const r = await text({ task: "twin_edits", system: SYS_EDITS, messages: [{ role: "user", content: summary }], maxTokens: 250 });
    const parsed = parseTwinJSON(r.text);
    if (!parsed) return;
    writeTwinInsight({ category: parsed.category, insight: parsed.insight, confidence: parsed.confidence, contraindication: parsed.contraindication, source: "edits" });
    if (parsed.contraindication) {
      createNode({ domain: "constraints", label: parsed.contraindication.slice(0, 80), type: "constraint", status: "active", detail: `Inferred from user edits: ${parsed.insight}` });
    }
    console.log(`[Twin] learned: ${parsed.insight}`);
  } catch (err: any) {
    console.error("[Twin Edits] error:", err.message);
  }
}

export async function twinLearnFromResults(payload: { steps_result: { step: string; status: string; result: string }[]; plan_summary: string }): Promise<void> {
  const summary = `Plan: ${payload.plan_summary}\n\nSteps:\n${payload.steps_result.map(s => `[${s.status}] ${s.step}: ${s.result.slice(0, 200)}`).join("\n")}`;
  try {
    const r = await text({ task: "twin_results", system: SYS_RESULTS, messages: [{ role: "user", content: summary }], maxTokens: 250 });
    const parsed = parseTwinJSON(r.text);
    if (!parsed) return;
    writeTwinInsight({ category: parsed.category, insight: parsed.insight, confidence: parsed.confidence, contraindication: parsed.contraindication, source: "results" });
  } catch (err: any) {
    console.error("[Twin Results] error:", err.message);
  }
}

function parseTwinJSON(raw: string): { category: string; insight: string; confidence: number; contraindication?: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.category !== "string" || typeof j.insight !== "string" || typeof j.confidence !== "number") return null;
    return {
      category: j.category,
      insight: j.insight,
      confidence: Math.max(0, Math.min(1, j.confidence)),
      contraindication: typeof j.contraindication === "string" && j.contraindication !== "null" ? j.contraindication : undefined,
    };
  } catch {
    return null;
  }
}
