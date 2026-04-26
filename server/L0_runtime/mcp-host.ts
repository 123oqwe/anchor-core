/**
 * L0 Runtime — MCP Host (subprocess manager + tool discovery).
 *
 * Anchor acts as an MCP client. Spawns user-installed MCP servers as
 * subprocesses, speaks JSON-RPC over stdio, discovers tools, registers
 * each into L1 tool registry as `mcp_<server>_<tool>`.
 *
 * Cross-platform: Node child_process works identically Mac/Win/Linux.
 * Server binaries themselves (apple-mcp / gmail-mcp / etc) own their
 * own platform compatibility.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "./db.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "anchor-core", version: "0.1.0" };

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, any>; required?: string[] };
}

export interface MCPCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  status: "connected" | "disconnected" | "error";
  tools: MCPTool[];
  lastError?: string;
}

class MCPClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private cfg: { command: string; args: string[]; env?: Record<string, string>; callTimeoutMs?: number }) {
    super();
  }

  async connect(timeoutMs = 15_000): Promise<{ serverInfo: any; capabilities: any }> {
    this.proc = spawn(this.cfg.command, this.cfg.args, {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (b: Buffer) => this.onStdout(b));
    this.proc.stderr!.on("data", (b: Buffer) => this.emit("stderr", b.toString()));
    this.proc.on("exit", (code) => {
      this.pending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error(`MCP exit ${code}`)); });
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeoutMs);
    this.notify("notifications/initialized", {});
    return { serverInfo: init.serverInfo ?? {}, capabilities: init.capabilities ?? {} };
  }

  async listTools(): Promise<MCPTool[]> {
    const r = await this.request("tools/list", {});
    return Array.isArray(r?.tools) ? r.tools : [];
  }

  async callTool(name: string, args: any): Promise<MCPCallResult> {
    return await this.request("tools/call", { name, arguments: args ?? {} });
  }

  disconnect(): void {
    if (this.proc && !this.proc.killed) try { this.proc.kill("SIGTERM"); } catch {}
    this.proc = null;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg?.id !== undefined && this.pending.has(msg.id)) {
          const e = this.pending.get(msg.id)!;
          clearTimeout(e.timer);
          this.pending.delete(msg.id);
          if (msg.error) e.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
          else e.resolve(msg.result);
        }
      } catch { /* ignore non-JSON lines */ }
    }
  }

  private request(method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = this.nextId++;
    const ms = timeoutMs ?? this.cfg.callTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timeout`)); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.proc?.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("MCP subprocess not writable"));
        return;
      }
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: any): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

const connections = new Map<string, MCPClient>();

export function listServers(): MCPServerConfig[] {
  const rows = db.prepare("SELECT * FROM mcp_servers WHERE user_id=? ORDER BY created_at").all(DEFAULT_USER_ID) as any[];
  return rows.map(rowToConfig);
}

export function getServer(id: string): MCPServerConfig | null {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id=? AND user_id=?").get(id, DEFAULT_USER_ID) as any;
  return row ? rowToConfig(row) : null;
}

export function createServer(input: {
  name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean;
}): MCPServerConfig {
  const id = nanoid();
  db.prepare(
    `INSERT INTO mcp_servers (id, user_id, name, transport, command, args_json, env_json, enabled)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id, DEFAULT_USER_ID, input.name, "stdio",
    input.command, JSON.stringify(input.args ?? []), JSON.stringify(input.env ?? {}),
    input.enabled === false ? 0 : 1,
  );
  return getServer(id)!;
}

export function deleteServer(id: string): boolean {
  disconnectServer(id);
  return db.prepare("DELETE FROM mcp_servers WHERE id=? AND user_id=?").run(id, DEFAULT_USER_ID).changes > 0;
}

export async function connectServer(id: string): Promise<{ ok: boolean; tools: MCPTool[]; error?: string }> {
  const cfg = getServer(id);
  if (!cfg) return { ok: false, tools: [], error: "server not found" };
  if (connections.has(id)) disconnectServer(id);

  const client = new MCPClient({ command: cfg.command, args: cfg.args, env: cfg.env });
  try {
    await client.connect();
    const tools = await client.listTools();
    connections.set(id, client);
    db.prepare(`UPDATE mcp_servers SET status=?, last_connected_at=datetime('now'), tools_json=?, last_error=NULL, updated_at=datetime('now') WHERE id=?`)
      .run("connected", JSON.stringify(tools), id);
    // Register each tool into L1 (lazy import to avoid circular)
    const reg = await import("../L1_tools/registry.js");
    for (const t of tools) {
      const slug = cfg.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
      const toolName = `mcp_${slug}_${t.name}`;
      reg.registerTool({
        name: toolName,
        description: `[MCP:${cfg.name}] ${t.description ?? t.name}`,
        handler: "mcp",
        actionClass: "send_external",
        inputSchema: { type: "object", properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required },
        execute: async (input) => {
          const c = connections.get(id);
          if (!c) return { success: false, output: `MCP ${cfg.name} disconnected`, error: "MCP_DISCONNECTED" };
          try {
            const r = await c.callTool(t.name, input);
            const flat = (r.content ?? []).map((p: any) => p?.text ?? JSON.stringify(p)).join("\n");
            return { success: !r.isError, output: flat.slice(0, 4096), ...(r.isError ? { error: "MCP_TOOL_ERROR" } : {}) };
          } catch (err: any) {
            return { success: false, output: err?.message ?? "mcp call failed", error: "MCP_CALL_FAILED" };
          }
        },
      });
    }
    return { ok: true, tools };
  } catch (err: any) {
    client.disconnect();
    db.prepare(`UPDATE mcp_servers SET status=?, last_error=?, updated_at=datetime('now') WHERE id=?`).run("error", err?.message ?? String(err), id);
    return { ok: false, tools: [], error: err?.message ?? String(err) };
  }
}

export function disconnectServer(id: string): void {
  const c = connections.get(id);
  if (c) { c.disconnect(); connections.delete(id); }
  const cfg = getServer(id);
  if (cfg) {
    const slug = cfg.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    import("../L1_tools/registry.js").then(reg => {
      for (const t of cfg.tools) reg.unregisterTool(`mcp_${slug}_${t.name}`);
    }).catch(() => {});
  }
  db.prepare(`UPDATE mcp_servers SET status=?, updated_at=datetime('now') WHERE id=?`).run("disconnected", id);
}

export async function initMCPHost(): Promise<void> {
  const servers = listServers().filter(s => s.enabled);
  if (!servers.length) return;
  console.log(`[MCP Host] auto-connecting ${servers.length} server(s)...`);
  await Promise.all(servers.map(async s => {
    try {
      const r = await connectServer(s.id);
      console.log(`[MCP Host] ${s.name}: ${r.ok ? `${r.tools.length} tools` : r.error}`);
    } catch (err: any) {
      console.log(`[MCP Host] ${s.name}: ${err.message}`);
    }
  }));
}

function rowToConfig(row: any): MCPServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? "",
    args: JSON.parse(row.args_json || "[]"),
    env: JSON.parse(row.env_json || "{}"),
    enabled: row.enabled === 1,
    status: row.status,
    tools: JSON.parse(row.tools_json || "[]"),
    lastError: row.last_error ?? undefined,
  };
}
