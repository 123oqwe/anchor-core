/**
 * L3 — Onboarding scan via MCP servers.
 *
 * Replaces anchor-backend's macOS-specific runLocalScan. Scans whatever
 * MCP servers are connected and exposes "list/recent" style tools.
 *
 * Pattern: capability contract. We look for tools matching common shapes
 * (mail/list, messages/list, calendar/list, notes/search) and pull the
 * last `sinceDays` worth, feeding through the same extractor.
 */
import { getAllTools, executeTool } from "../L1_tools/registry.js";
import { extractFromText } from "../L2_memory/extractor.js";
import { logExecution } from "../L0_runtime/db.js";

export interface ScanResult {
  sourcesScanned: string[];
  eventsCollected: number;
  nodesCreated: number;
  memoriesCreated: number;
}

const CAPABILITY_PATTERNS: { capability: string; matchers: RegExp[] }[] = [
  { capability: "messaging", matchers: [/messages?$/, /chat$/, /imessage/] },
  { capability: "email",     matchers: [/mail/, /gmail/, /outlook/, /email/] },
  { capability: "calendar",  matchers: [/calendar/, /events?$/] },
  { capability: "notes",     matchers: [/notes?$/, /obsidian/, /notion/] },
  { capability: "contacts",  matchers: [/contacts?$/] },
  { capability: "tasks",     matchers: [/reminders?$/, /todos?$/, /tasks?$/] },
];

function findMcpToolsForCapability(cap: string): string[] {
  const patterns = CAPABILITY_PATTERNS.find(c => c.capability === cap)?.matchers ?? [];
  return getAllTools()
    .filter(t => t.handler === "mcp")
    .filter(t => patterns.some(re => re.test(t.name.toLowerCase())))
    .map(t => t.name);
}

export async function runOnboardingScan(opts?: { sinceDays?: number }): Promise<ScanResult> {
  const sinceDays = opts?.sinceDays ?? 14;
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const sourcesScanned: string[] = [];
  let eventsCollected = 0;
  let nodesCreated = 0;
  let memoriesCreated = 0;

  for (const { capability } of CAPABILITY_PATTERNS) {
    const tools = findMcpToolsForCapability(capability);
    for (const toolName of tools) {
      try {
        const r = await executeTool(toolName, { operation: "list", since, limit: 200 }, undefined, "user_triggered");
        if (!r.success || !r.output) continue;
        sourcesScanned.push(toolName);
        eventsCollected++;
        const ex = await extractFromText(`[${capability} events from last ${sinceDays} days]\n${r.output}`);
        nodesCreated += ex.nodesCreated;
        if (ex.memoryCreated) memoriesCreated++;
      } catch (err: any) {
        console.error(`[Onboarding] ${toolName} failed:`, err.message);
      }
    }
  }

  logExecution("Onboarding", `scanned ${sourcesScanned.length} sources → ${nodesCreated} nodes`);
  return { sourcesScanned, eventsCollected, nodesCreated, memoriesCreated };
}
