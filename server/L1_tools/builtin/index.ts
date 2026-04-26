/**
 * L1 Tools — Built-in tools registration.
 *
 * Only cross-platform tools live here. Anything that needs to read user files,
 * control native apps, or talk to a specific OS API → MCP server, not built-in.
 *
 * 8 tools:
 *   - DB:        write_task, update_graph_node, record_outcome, db_query
 *   - Network:   web_search, fetch_url
 *   - Code:      execute_code (sandboxed)
 *   - Internal:  agent_state_get, agent_state_set
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../../L0_runtime/db.js";
import { registerTool, type ToolResult } from "../registry.js";
import { spawn } from "node:child_process";
import { writeMemory } from "../../L2_memory/memory.js";

export function registerBuiltinTools(): void {

  // ── write_task ──────────────────────────────────────────────────
  registerTool({
    name: "write_task",
    description: "Create a task in user's workspace.",
    handler: "db",
    actionClass: "write_task",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        project_id: { type: "string", description: "Optional project to attach to" },
      },
      required: ["title"],
    },
    execute: (input): ToolResult => {
      const id = nanoid();
      db.prepare("INSERT INTO tasks (id, user_id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?,?)")
        .run(id, DEFAULT_USER_ID, input.project_id ?? null, input.title, "todo", input.priority ?? "medium", JSON.stringify(["auto"]));
      return { success: true, output: `Task created: "${input.title}"`, data: { taskId: id } };
    },
  });

  // ── update_graph_node ────────────────────────────────────────────
  registerTool({
    name: "update_graph_node",
    description: "Update a knowledge graph node's status.",
    handler: "db",
    actionClass: "write_graph",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        status: { type: "string", description: "active | done | paused | decaying" },
      },
      required: ["node_id", "status"],
    },
    execute: (input): ToolResult => {
      const r = db.prepare("UPDATE graph_nodes SET status=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
        .run(input.status, input.node_id, DEFAULT_USER_ID);
      if (r.changes === 0) return { success: false, output: `Node ${input.node_id} not found`, error: "NOT_FOUND" };
      return { success: true, output: `Node ${input.node_id} → ${input.status}` };
    },
  });

  // ── record_outcome ───────────────────────────────────────────────
  registerTool({
    name: "record_outcome",
    description: "Record an outcome / observation as a memory.",
    handler: "db",
    actionClass: "write_memory",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        type: { type: "string", description: "episodic | semantic | working" },
      },
      required: ["title", "content"],
    },
    execute: (input): ToolResult => {
      const id = writeMemory({ type: input.type ?? "episodic", title: input.title, content: input.content, source: "tool:record_outcome" });
      return { success: true, output: `Memory recorded: "${input.title}"`, data: { memoryId: id } };
    },
  });

  // ── db_query ─────────────────────────────────────────────────────
  registerTool({
    name: "db_query",
    description: "Read-only SQL query against anchor's local DB. SELECT only.",
    handler: "db",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SELECT statement (no INSERT/UPDATE/DELETE)" },
      },
      required: ["sql"],
    },
    execute: (input): ToolResult => {
      const sql = String(input.sql).trim();
      if (!/^select\s/i.test(sql)) return { success: false, output: "db_query is read-only (SELECT only)", error: "WRITE_REJECTED" };
      try {
        const rows = db.prepare(sql).all();
        return { success: true, output: `${rows.length} rows`, data: { rows: rows.slice(0, 100) } };
      } catch (err: any) {
        return { success: false, output: `SQL error: ${err.message}`, error: "SQL_ERROR" };
      }
    },
  });

  // ── web_search ───────────────────────────────────────────────────
  registerTool({
    name: "web_search",
    description: "Search the web. DuckDuckGo HTML scraping (no key) or Tavily/Perplexity if TAVILY_API_KEY is set.",
    handler: "api",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async (input): Promise<ToolResult> => {
      if (process.env.TAVILY_API_KEY) {
        try {
          const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: input.query, max_results: 5 }),
          });
          const data: any = await res.json();
          const results = (data.results ?? []).map((r: any) => `${r.title}\n${r.url}\n${r.content}`).join("\n---\n");
          return { success: true, output: results.slice(0, 4096), data: { results: data.results } };
        } catch (err: any) {
          return { success: false, output: `Tavily error: ${err.message}`, error: err.message };
        }
      }
      // Fallback: DuckDuckGo HTML
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 anchor-core" } });
        const html = await res.text();
        const matches = html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g);
        const results = Array.from(matches).slice(0, 5).map(m => `${m[2]}\n${decodeURIComponent(m[1])}`);
        return { success: true, output: results.join("\n---\n").slice(0, 4096), data: { results } };
      } catch (err: any) {
        return { success: false, output: `Search error: ${err.message}`, error: err.message };
      }
    },
  });

  // ── fetch_url ────────────────────────────────────────────────────
  registerTool({
    name: "fetch_url",
    description: "Fetch a URL and return text content (HTML stripped).",
    handler: "api",
    actionClass: "read_memory",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        const res = await fetch(input.url, { headers: { "User-Agent": "Mozilla/5.0 anchor-core" } });
        if (!res.ok) return { success: false, output: `HTTP ${res.status}`, error: `HTTP_${res.status}` };
        const html = await res.text();
        const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return { success: true, output: text.slice(0, 8192) };
      } catch (err: any) {
        return { success: false, output: `Fetch error: ${err.message}`, error: err.message };
      }
    },
  });

  // ── execute_code ─────────────────────────────────────────────────
  registerTool({
    name: "execute_code",
    description: "Run code in a sandboxed subprocess. Supports python (if installed) and node.",
    handler: "code",
    actionClass: "execute_code",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "node"] },
        code: { type: "string" },
      },
      required: ["language", "code"],
    },
    execute: async (input): Promise<ToolResult> => {
      const cmd = input.language === "python" ? "python3" : "node";
      return new Promise<ToolResult>((resolve) => {
        const proc = spawn(cmd, ["-e", input.code], { timeout: 10_000 });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (b) => { stdout += b.toString(); });
        proc.stderr.on("data", (b) => { stderr += b.toString(); });
        proc.on("exit", (code) => {
          if (code === 0) resolve({ success: true, output: stdout.slice(0, 4096) });
          else resolve({ success: false, output: stderr.slice(0, 4096), error: `exit ${code}` });
        });
        proc.on("error", (err) => resolve({ success: false, output: err.message, error: "SPAWN_FAILED" }));
      });
    },
  });

  // ── agent_state_get / agent_state_set ───────────────────────────
  registerTool({
    name: "agent_state_get",
    description: "Read a value from custom-agent KV state.",
    handler: "internal",
    actionClass: "read_memory",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    execute: (input, ctx): ToolResult => {
      const aid = ctx?.agentId ?? "global";
      const row = db.prepare("SELECT value_json FROM agent_state WHERE agent_id=? AND key=?").get(aid, input.key) as any;
      if (!row) return { success: true, output: "(empty)", data: { value: null } };
      return { success: true, output: row.value_json, data: { value: JSON.parse(row.value_json) } };
    },
  });

  registerTool({
    name: "agent_state_set",
    description: "Write a value to custom-agent KV state.",
    handler: "internal",
    actionClass: "write_memory",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: {} },
      required: ["key", "value"],
    },
    execute: (input, ctx): ToolResult => {
      const aid = ctx?.agentId ?? "global";
      db.prepare(
        "INSERT INTO agent_state (agent_id, key, value_json) VALUES (?,?,?) ON CONFLICT(agent_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=datetime('now')"
      ).run(aid, input.key, JSON.stringify(input.value));
      return { success: true, output: `Set ${input.key}` };
    },
  });
}
