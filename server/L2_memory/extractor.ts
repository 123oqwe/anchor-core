/**
 * L2 Memory — Extractor: NL events → graph nodes + memories.
 *
 * Pure data flow: input is text or structured events from MCP servers,
 * output is graph_nodes / memories writes. Source-agnostic — same code
 * works whether events came from apple-mcp, gmail-mcp, or manual entry.
 */
import { z } from "zod";
import { text } from "../L0_runtime/llm-gateway.js";
import { createNode } from "./graph.js";
import { writeMemory } from "./memory.js";

const ExtractionSchema = z.object({
  nodes: z.array(z.object({
    domain: z.enum(["people", "projects", "tasks", "values", "constraints", "preferences", "interests", "risks", "health", "other"]),
    label: z.string().min(1),
    type: z.enum(["person", "project", "task", "value", "constraint", "preference", "interest", "risk", "behavioral_pattern"]),
    status: z.string().default("active"),
    detail: z.string().default(""),
  })).default([]),
  memory: z.object({
    title: z.string(),
    content: z.string(),
    type: z.enum(["episodic", "semantic", "working"]).default("episodic"),
  }).optional(),
});

const SYSTEM = `You are Anchor's extractor. Read raw event text and produce a JSON object with:
  - nodes: list of knowledge graph nodes to create (people, projects, values, constraints, etc)
  - memory: optional single memory record summarizing this event

Be conservative. Only extract entities that are clearly mentioned.
Output JSON only — no markdown, no commentary.`;

export async function extractFromText(rawText: string): Promise<{ nodesCreated: number; memoryCreated: boolean }> {
  if (!rawText || rawText.length < 30) return { nodesCreated: 0, memoryCreated: false };

  let parsed: z.infer<typeof ExtractionSchema>;
  try {
    const r = await text({
      task: "extract",
      system: SYSTEM,
      messages: [{ role: "user", content: rawText.slice(0, 8000) }],
      maxTokens: 800,
    });
    const jsonMatch = r.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { nodesCreated: 0, memoryCreated: false };
    parsed = ExtractionSchema.parse(JSON.parse(jsonMatch[0]));
  } catch (err: any) {
    console.error("[Extractor] parse failed:", err.message);
    return { nodesCreated: 0, memoryCreated: false };
  }

  let nodesCreated = 0;
  for (const n of parsed.nodes) {
    createNode({ domain: n.domain, label: n.label, type: n.type, status: n.status, detail: n.detail });
    nodesCreated++;
  }
  let memoryCreated = false;
  if (parsed.memory) {
    writeMemory({ type: parsed.memory.type, title: parsed.memory.title, content: parsed.memory.content, source: "extractor" });
    memoryCreated = true;
  }
  return { nodesCreated, memoryCreated };
}
