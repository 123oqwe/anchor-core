/**
 * L3 — General chat. Quick LLM passthrough with light personalization.
 *
 * For richer "advisor recommends with plan" → use decide() in decision.ts.
 */
import { text } from "../L0_runtime/llm-gateway.js";
import { serializeGraphForPrompt } from "../L2_memory/graph.js";

export async function chat(message: string, history?: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const system = [
    "You are Anchor, a personal AI assistant. Be concise, direct, and grounded.",
    "If the user asks for action, suggest using /advisor for a structured plan.",
    serializeGraphForPrompt(),
  ].filter(Boolean).join("\n");

  const r = await text({
    task: "chat",
    system,
    messages: [...(history ?? []), { role: "user", content: message }],
    maxTokens: 800,
  });
  return r.text;
}
