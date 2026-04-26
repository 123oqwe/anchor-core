/**
 * L0 Runtime — LLM Gateway.
 *
 * Provider abstraction. Cloud-first (Anthropic) with Ollama path stubbed for
 * future local model support. Caller never imports a provider SDK directly.
 *
 * Cross-platform: pure HTTP / official SDK, no OS specifics.
 */
import Anthropic from "@anthropic-ai/sdk";
import { db, DEFAULT_USER_ID, logLLMCall } from "./db.js";

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface TextOpts {
  task: string;
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  model?: string;
  tools?: { name: string; description: string; input_schema: any }[];
}

export interface TextResult {
  text: string;
  toolCalls: { name: string; input: any }[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  modelId: string;
  tokensUsed: { input: number; output: number };
}

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function getModel(opts: TextOpts): string {
  if (opts.model) return opts.model;
  const settings = db.prepare("SELECT model_reasoning, model_fast FROM settings WHERE user_id=?").get(DEFAULT_USER_ID) as any;
  return settings?.model_reasoning ?? "claude-sonnet-4-6";
}

export async function text(opts: TextOpts): Promise<TextResult> {
  if (!anthropic) {
    throw new Error("LLM gateway: ANTHROPIC_API_KEY not set. Add it to .env or set OLLAMA_BASE_URL for local mode.");
  }

  const modelId = getModel(opts);
  const systemMsgs = opts.messages.filter(m => m.role === "system").map(m => m.content);
  const turnMsgs = opts.messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

  const systemPrompt = [opts.system, ...systemMsgs].filter(Boolean).join("\n\n");
  const start = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: modelId,
      max_tokens: opts.maxTokens ?? 1024,
      system: systemPrompt || undefined,
      messages: turnMsgs.length ? turnMsgs : [{ role: "user", content: " " }],
      tools: opts.tools as any,
    });

    let outText = "";
    const toolCalls: { name: string; input: any }[] = [];
    for (const block of response.content) {
      if (block.type === "text") outText += block.text;
      else if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
    }

    logLLMCall({
      task: opts.task, modelId,
      inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
      latencyMs: Date.now() - start, status: "success",
    });

    return {
      text: outText, toolCalls,
      stopReason: response.stop_reason as any ?? "end_turn",
      modelId,
      tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  } catch (err: any) {
    logLLMCall({ task: opts.task, modelId, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - start, status: "failed", error: err?.message?.slice(0, 300) });
    throw err;
  }
}
