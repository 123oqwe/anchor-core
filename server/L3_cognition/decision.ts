/**
 * L3 — Decision Agent.
 *
 * Builds a plan from natural-language user input. System prompt assembled
 * from: graph context + memory + Twin insights + value constitution.
 *
 * Output is a structured plan the user can edit, then confirm; on confirm
 * the bus emits USER_CONFIRMED → SessionRunner takes over.
 */
import { text } from "../L0_runtime/llm-gateway.js";
import { db, DEFAULT_USER_ID } from "../L0_runtime/db.js";
import { serializeGraphForPrompt, buildValueConstitution } from "../L2_memory/graph.js";
import { searchMemoryFTS, getTwinInsights, serializeMemoriesForPrompt, serializeTwinForPrompt } from "../L2_memory/memory.js";

export interface PlanStep { id: number; content: string; tool?: string; time_estimate?: string }

export interface DecisionResult {
  raw: string;
  isPlan: boolean;
  plan?: {
    type: string;
    suggestion_summary: string;
    reasoning: string;
    steps: PlanStep[];
    risk_level: "low" | "medium" | "high";
    why_this_now?: string;
    confidence?: number;
  };
}

function buildSystemPrompt(message: string): string {
  const graph = serializeGraphForPrompt();
  const constitution = buildValueConstitution();
  const memorySnippets = searchMemoryFTS(message.slice(0, 80), 5);
  const memText = serializeMemoriesForPrompt(memorySnippets);
  const twin = getTwinInsights(15);
  const twinText = serializeTwinForPrompt(twin);

  return [
    `You are Anchor's Decision Agent. The user wants you to recommend a course of action.`,
    `Use the user's knowledge graph, value constitution, recent memories, and Twin insights to ground your recommendation.`,
    `If the user just wants information / chat, answer directly without producing a plan.`,
    `If the user wants action, output a structured JSON plan.`,
    ``,
    constitution,
    graph,
    memText,
    twinText,
    ``,
    `OUTPUT (when proposing a plan):`,
    `{`,
    `  "type": "plan",`,
    `  "suggestion_summary": "one-line summary",`,
    `  "reasoning": "why this is the right move",`,
    `  "steps": [{"id":1,"content":"step text","tool":"tool_name (optional)","time_estimate":"5 min"}],`,
    `  "risk_level": "low | medium | high",`,
    `  "why_this_now": "what changed in graph/memory that makes this timely",`,
    `  "confidence": 0.0-1.0`,
    `}`,
    ``,
    `If just chatting / answering: respond plainly with NO JSON.`,
  ].filter(Boolean).join("\n");
}

export async function decide(message: string, history?: { role: string; content: string }[]): Promise<DecisionResult> {
  const system = buildSystemPrompt(message);
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const h of history ?? []) {
    if (h.role === "user" || h.role === "assistant") messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: message });

  const r = await text({ task: "decision", system, messages, maxTokens: 1500 });

  // Try parse a JSON plan; if no JSON, treat as plain answer
  const jsonMatch = r.text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
  if (!jsonMatch) {
    return { raw: r.text, isPlan: false };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { raw: r.text, isPlan: true, plan: parsed };
  } catch {
    return { raw: r.text, isPlan: false };
  }
}

export function persistPlanAsSession(userText: string, plan: NonNullable<DecisionResult["plan"]>): string {
  const { nanoid } = require("nanoid");
  const sessionId = nanoid();
  db.prepare(
    "INSERT INTO action_sessions (id, user_id, plan_summary, status) VALUES (?,?,?,?)"
  ).run(sessionId, DEFAULT_USER_ID, plan.suggestion_summary, "compiled");
  for (const step of plan.steps) {
    db.prepare(
      "INSERT INTO action_steps (id, session_id, step_index, content, tool, status) VALUES (?,?,?,?,?,?)"
    ).run(nanoid(), sessionId, step.id, step.content, step.tool ?? null, "pending");
  }
  return sessionId;
}
