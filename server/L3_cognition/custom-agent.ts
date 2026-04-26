/**
 * L3 — Custom Agent (user-defined ReAct loop).
 *
 * User defines instructions + allowed tool set. Anchor injects relevant
 * graph + Twin context, then runs an Anthropic-tools ReAct loop using only
 * the whitelisted tools.
 *
 * Stops when: max iterations / no tool call (final answer) / tool fails non-recoverably.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../L0_runtime/db.js";
import { text } from "../L0_runtime/llm-gateway.js";
import { executeTool, getAllTools, type ExecutionContext } from "../L1_tools/registry.js";
import { serializeGraphForPrompt } from "../L2_memory/graph.js";
import { getTwinInsights, serializeTwinForPrompt } from "../L2_memory/memory.js";

export interface CustomAgentRow {
  id: string;
  name: string;
  instructions: string;
  toolsAllowed: string[];
  triggerType: string;
  enabled: boolean;
}

export function listCustomAgents(): CustomAgentRow[] {
  const rows = db.prepare("SELECT * FROM user_agents WHERE user_id=? ORDER BY created_at").all(DEFAULT_USER_ID) as any[];
  return rows.map(rowToAgent);
}

export function getCustomAgent(id: string): CustomAgentRow | null {
  const row = db.prepare("SELECT * FROM user_agents WHERE id=? AND user_id=?").get(id, DEFAULT_USER_ID) as any;
  return row ? rowToAgent(row) : null;
}

export function createCustomAgent(input: { name: string; instructions: string; tools?: string[]; triggerType?: string }): CustomAgentRow {
  const id = nanoid();
  db.prepare(
    "INSERT INTO user_agents (id, user_id, name, instructions, tools_json, trigger_type) VALUES (?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, input.name, input.instructions, JSON.stringify(input.tools ?? []), input.triggerType ?? "manual");
  return getCustomAgent(id)!;
}

export function deleteCustomAgent(id: string): boolean {
  return db.prepare("DELETE FROM user_agents WHERE id=? AND user_id=?").run(id, DEFAULT_USER_ID).changes > 0;
}

export async function runCustomAgent(agentId: string, message: string, maxIter = 8): Promise<{
  finalText: string;
  toolCallCount: number;
  trace: { iter: number; toolName?: string; toolInput?: any; toolOutput?: string; text?: string }[];
}> {
  const agent = getCustomAgent(agentId);
  if (!agent) throw new Error(`agent ${agentId} not found`);

  const allTools = getAllTools();
  const allowed = agent.toolsAllowed.length === 0
    ? allTools  // empty allowlist = give it everything
    : allTools.filter(t => agent.toolsAllowed.includes(t.name));

  const toolDefs = allowed.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

  const ctx: ExecutionContext = { agentId, runId: nanoid() };

  const system = [
    agent.instructions,
    "",
    "User context (knowledge graph + Twin insights):",
    serializeGraphForPrompt(),
    serializeTwinForPrompt(getTwinInsights(10)),
    "",
    `You have ${allowed.length} tools available. Use them to fulfill the user's request. When done, give a final answer with no tool call.`,
  ].filter(Boolean).join("\n");

  const trace: { iter: number; toolName?: string; toolInput?: any; toolOutput?: string; text?: string }[] = [];
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: message }];
  let toolCallCount = 0;
  let finalText = "";

  for (let iter = 0; iter < maxIter; iter++) {
    const r = await text({ task: "custom_agent", system, messages, maxTokens: 1024, tools: toolDefs });

    // Append assistant turn into transcript
    if (r.text) messages.push({ role: "assistant", content: r.text });

    if (r.toolCalls.length === 0) {
      finalText = r.text;
      trace.push({ iter, text: r.text });
      break;
    }

    // Execute tool calls in order; feed results back as new user turn
    const resultParts: string[] = [];
    for (const call of r.toolCalls) {
      toolCallCount++;
      const result = await executeTool(call.name, call.input, ctx, "agent_chain");
      resultParts.push(`[Tool ${call.name}] ${result.success ? result.output : `ERROR: ${result.error}`}`);
      trace.push({ iter, toolName: call.name, toolInput: call.input, toolOutput: result.output });
    }
    messages.push({ role: "user", content: resultParts.join("\n\n") });
  }

  return { finalText, toolCallCount, trace };
}

function rowToAgent(row: any): CustomAgentRow {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    toolsAllowed: JSON.parse(row.tools_json || "[]"),
    triggerType: row.trigger_type,
    enabled: row.enabled === 1,
  };
}
