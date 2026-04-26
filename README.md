# anchor-core

Cross-platform MCP-first personal AI agent runtime. 5 layers, ~2000 lines, no OS-specific code in the core.

## Why this exists

`anchor-backend` is the original implementation, born on macOS with ~3000 lines of AppleScript / native Mac scanners and a layered architecture that grew to 8 layers over time. `anchor-core` is the simplified version applying Karpathy's principles:

1. **Think before coding** — only build what user-visible features need.
2. **Simplicity first** — minimum code; if 200 could be 50, rewrite.
3. **Surgical changes** — every changed line traces to a real product requirement.
4. **Goal-driven execution** — verifiable success per commit.

The product capability is unchanged from anchor-backend. What changes is **how** capabilities arrive: instead of bespoke macOS scanners, all "read user data / control user devices" is delegated to MCP servers (apple-mcp, gmail-mcp, linear-mcp, etc). Anchor-core itself ships zero OS-specific code.

## 5-layer architecture

```
L5 Surface         HTTP routes + SSE
L4 Orchestration   Bus + handlers + dispatch hub + SessionRunner + approval queue
L3 Cognition       Decision / Twin / Custom Agent / Chat / Onboarding /
                   system_agents (Dream / GEPA / Evolution / Skills / Diagnostic / Oracle Council)
L2 Memory + Graph  episodic / semantic / working memories + bi-temporal Personal Knowledge Graph
L1 Tools           registry + permission gate + ~10 cross-platform builtins + MCP-discovered tools
L0 Runtime         SQLite WAL + LLM Gateway + MCP Host (subprocess manager)
```

See `docs/ARCHITECTURE.md` for the full picture.

## What's working today

| Feature | Status |
|---------|--------|
| MCP host (auto-spawn user-installed MCP servers, register their tools) | ✅ |
| ~10 cross-platform builtin tools (web_search, fetch_url, execute_code, db_query, write_task, etc) | ✅ |
| Decision Agent (NL → structured plan grounded in graph + Twin insights) | ✅ |
| Twin Agent (learns from USER_CONFIRMED edits + EXECUTION_DONE results) | ✅ |
| Plan FSM (SessionRunner walks compiled plan → tools → bus events) | ✅ |
| Custom Agents (user-defined ReAct loops with tool whitelist) | ✅ |
| Workspace (projects + tasks with bi-temporal state) | ✅ |
| Memory (FTS5 search, recent, write, twin insights) | ✅ |
| Cron + dispatch hub (1 unified scheduler vs anchor-backend's 6) | ✅ |
| Approval queue (gated tool calls land here for user decision) | ✅ |
| Onboarding scan (via MCP servers, capability-pattern matched) | ✅ |
| Chat | ✅ |
| Dream / GEPA / Evolution / Skills / Diagnostic / Oracle Council | 🟡 stubbed (Phase 2 ports) |

## Cross-platform

No `process.platform` checks. No AppleScript. No `osascript`. Tested boot path is pure Node + SQLite + Anthropic SDK + node-cron + Express.

OS-specific capabilities (read iMessage / send email via Apple Mail / control desktop GUI) come from MCP servers the user installs. Anchor-core neither knows nor cares which OS they target.

## Getting started

```bash
pnpm install
cp .env.example .env       # add ANTHROPIC_API_KEY
pnpm dev                   # boots on :3010
```

Try:
```bash
curl http://localhost:3010/health
curl -X POST http://localhost:3010/api/chat -H "Content-Type: application/json" -d '{"message":"hi"}'
```

Add an MCP server (example: apple-mcp on Mac):
```bash
curl -X POST http://localhost:3010/api/mcp -H "Content-Type: application/json" \
  -d '{"name":"apple-mcp","command":"npx","args":["-y","@dhravya/apple-mcp"]}'
curl -X POST http://localhost:3010/api/mcp/<id>/connect
```

After connect: all apple-mcp tools (mail / messages / notes / contacts / calendar / reminders) are auto-registered into anchor-core's tool registry as `mcp_apple_mcp_<tool>`. Any custom agent can use them. Onboarding scan picks them up automatically.

## API surface (12 routes)

```
GET  /health                              — diagnostic counts + MCP status
POST /api/advisor                         — Decision Agent (NL → plan)
POST /api/advisor/confirm                 — accept (edited) plan → starts SessionRunner
GET/POST/DELETE /api/agents[/:id][/run]   — Custom Agent CRUD + run
GET/POST/PUT/DELETE /api/projects         — Workspace projects
GET/POST/PUT/DELETE /api/tasks            — Workspace tasks
GET/POST/SEARCH /api/memory               — Memory + Twin insights + extract
GET/POST/DELETE /api/mcp                  — MCP server CRUD + connect/disconnect
GET/POST/DELETE /api/cron                 — System + user cron schedules
POST /api/onboarding/scan                 — Initial scan via connected MCP servers
POST /api/onboarding/portrait             — Oracle Council stub (Phase 2)
POST /api/chat                            — General chat
GET/POST /api/approvals                   — Approval queue (decide pending tool calls)
GET/POST /api/tools                       — List + invoke registered tools
```

## What's NOT in anchor-core (vs anchor-backend)

- 11 macOS scanners (~3000 lines) — replaced by MCP capability matching in `onboarding.ts`
- 4 AppleScript / macOS bridges — replaced by MCP servers user installs
- 6 overlapping schedulers — collapsed to 1 dispatch hub with grain
- 12 system agents — stubbed to ports for Phase 2
- Mode-C 4-lock state spec — removed (unnecessary for personal N=1)
- `runtime` concept (duplicate of `handler`) — collapsed
- "compile failed: compileEmpty" path — removed
- L7 transport / L6 permission as separate layers — collapsed

## License

MIT
