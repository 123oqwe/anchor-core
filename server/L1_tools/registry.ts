/**
 * L1 Tools — Registry + unified execution.
 *
 * One registration shape for built-in tools AND MCP-discovered tools.
 * Permission gate applied uniformly. Logging unified.
 *
 * Cross-platform: only handler types are db / api / code / mcp / internal.
 * No `shell` or `applescript` handler — anything OS-specific goes through MCP.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID, logExecution } from "../L0_runtime/db.js";
import { checkPermission, type ActionClass, recordSuccess, recordFailure } from "./gate.js";

export type ToolHandler = "db" | "api" | "code" | "internal" | "mcp";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, any>; required?: string[] };
  actionClass: ActionClass;
  handler: ToolHandler;
  execute: (input: any, ctx?: ExecutionContext) => Promise<ToolResult> | ToolResult;
}

export interface ToolResult {
  success: boolean;
  output: string;
  data?: any;
  error?: string;
  shouldRetry?: boolean;
}

export interface ExecutionContext {
  agentId?: string;
  runId?: string;
  stepIndex?: number;
}

const registry = new Map<string, ToolDef>();

export function registerTool(tool: ToolDef): void {
  registry.set(tool.name, tool);
  console.log(`[Registry] ${tool.name} (${tool.handler}/${tool.actionClass})`);
}

export function unregisterTool(name: string): boolean {
  return registry.delete(name);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function getAllTools(): ToolDef[] {
  return Array.from(registry.values());
}

export function getToolsForLLM(): { name: string; description: string; input_schema: any }[] {
  return getAllTools().map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

export async function executeTool(
  name: string,
  input: any,
  ctx?: ExecutionContext,
  source: "user_triggered" | "cron" | "agent_chain" = "user_triggered",
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) return { success: false, output: `Unknown tool: ${name}`, error: "TOOL_NOT_FOUND" };

  const gate = checkPermission({ actionClass: tool.actionClass, description: `${name}(${JSON.stringify(input).slice(0, 80)})`, source });
  if (gate.decision === "deny") return { success: false, output: `Permission denied: ${gate.reason}`, error: "PERMISSION_DENIED" };
  if (gate.decision === "require_confirmation") {
    db.prepare(
      "INSERT INTO approval_queue (id, user_id, source, source_ref_id, action_class, description) VALUES (?,?,?,?,?,?)"
    ).run(nanoid(), DEFAULT_USER_ID, "tool_call", `${name}:${ctx?.runId ?? "ad-hoc"}`, tool.actionClass, gate.reason ?? `${name} requires confirmation`);
    return { success: false, output: `Pending approval: ${gate.reason}`, error: "NEEDS_CONFIRMATION" };
  }

  const start = Date.now();
  try {
    const result = await tool.execute(input, ctx);
    const latency = Date.now() - start;
    logExecution(`tool:${name}`, `${result.success ? "ok" : `ERR ${result.error}`} ${result.output.slice(0, 80)}`, result.success ? "success" : "failed", latency);
    if (result.success) recordSuccess(tool.actionClass);
    else recordFailure(tool.actionClass);
    return result;
  } catch (err: any) {
    const latency = Date.now() - start;
    logExecution(`tool:${name}`, `THROW ${err.message?.slice(0, 80)}`, "failed", latency);
    recordFailure(tool.actionClass);
    return { success: false, output: `Tool error: ${err.message}`, error: err.message, shouldRetry: true };
  }
}

export function getRegistryInfo() {
  return getAllTools().map(t => ({
    name: t.name, description: t.description, handler: t.handler, actionClass: t.actionClass, inputSchema: t.inputSchema,
  }));
}
