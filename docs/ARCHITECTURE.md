# anchor-core Architecture

## 5 layers (top → bottom = outer ring → inner ring)

```
┌─────────────────────────────────────────────────────────┐
│ L4 SURFACE                                              │
│   Express routes (12 endpoint groups) + SSE             │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP
┌──────────────────┴──────────────────────────────────────┐
│ L3 COGNITION + ORCHESTRATION                            │
│   ┌──────────────┐    ┌────────────────┐                │
│   │ Decision     │    │ Bus (events)   │                │
│   │ Twin         │    │ Handlers       │                │
│   │ Custom Agent │    │ Dispatch (cron)│                │
│   │ Chat         │    │ Approval queue │                │
│   │ Plan FSM     │    │                │                │
│   │ Onboarding   │    │                │                │
│   │ system_agents│ ←  Stubs for: Dream / GEPA /         │
│   └──────────────┘    Evolution / Skills / Diagnostic / │
│                       Oracle (Phase 2 ports)             │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────┴──────────────────────────────────────┐
│ L2 MEMORY + KNOWLEDGE                                   │
│   memory.ts (episodic/semantic/working + Twin insights) │
│   graph.ts (Personal Knowledge Graph + bi-temporal)     │
│   extractor.ts (NL → graph nodes)                       │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────┴──────────────────────────────────────┐
│ L1 TOOLS                                                │
│   registry.ts (unified tool registry, executeTool gate) │
│   gate.ts (permission classes — was L6)                 │
│   builtin/index.ts (~10 cross-platform tools)           │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────┴──────────────────────────────────────┐
│ L0 RUNTIME                                              │
│   db.ts (SQLite WAL + full schema + FTS5)               │
│   llm-gateway.ts (Anthropic now, Ollama-ready)          │
│   mcp-host.ts (subprocess manager + tool discovery)     │
│                                                         │
│           ↓ MCP protocol (stdio JSON-RPC)               │
│                                                         │
│   ──────── EXTERNAL MCP SERVERS (user-installed) ────── │
│   apple-mcp / gmail-mcp / linear-mcp / notion-mcp / ... │
│   These provide all OS-specific & app-specific tools.   │
│   Their tools auto-register into L1 as mcp_<srv>_<tool>.│
└─────────────────────────────────────────────────────────┘
```

## Data flow: Onboarding wow moment

```
User opens anchor-core (fresh install)
   │
   ▼
1. Connects MCP servers they want (via /api/mcp)
   apple-mcp / gmail-mcp / etc subprocess spawned
   │
   ▼
2. POST /api/onboarding/scan
   onboarding.ts scans each connected MCP server's
   list/recent tools → raw events
   │
   ▼
3. extractor.ts (LLM) turns raw text into graph nodes + memory
   │
   ▼
4. POST /api/onboarding/portrait
   Oracle Council stub returns initial portrait
   (Phase 2: 5-oracle synthesis ported from anchor-backend)
```

## Data flow: Advisor → Confirm → Twin learns

```
User: "what should I do about the X situation?"
   │
   ▼
POST /api/advisor → decide()
   buildSystemPrompt assembles:
     graph context + value constitution + memory + Twin insights
   LLM produces structured plan
   persistPlanAsSession writes action_sessions + action_steps
   │
   ▼
User edits plan in UI → POST /api/advisor/confirm
   bus.publish USER_CONFIRMED { sessionId, original, user_steps, changes }
   │
   ├─→ handlers.ts (sidecar): twinLearnFromEdits(changes)
   │      LLM extracts insight + contraindication → twin_insights table
   │      Decision Agent next call sees this in serializeTwinForPrompt
   │
   └─→ handlers.ts (main): startSession(sessionId)
          for each step → executeTool → log result
          on done: bus.publish EXECUTION_DONE
            → twinLearnFromResults (sidecar)
              LLM observes outcome → another insight stored
```

## Cross-platform contract

**Anchor-core never:**
- imports OS-specific libraries (no `osascript`, no Win32 APIs, no X11)
- branches on `process.platform`
- assumes file paths exist outside the repo

**Anchor-core always:**
- speaks MCP for any tool that needs OS access
- uses Node std lib + SQLite + Express + Anthropic SDK + node-cron
- runs identically on macOS / Windows / Linux

**OS-specific MCP servers (separate repos, planned):**
- `anchor-browser-mcp` — Chrome/Firefox/Edge history (cross-platform via known sqlite paths)
- `anchor-input-mcp` — keyboard / screenshot (cross-platform via cliclick / nut-tree / xdotool)
- `anchor-activity-mcp` — window focus tracking (cross-platform via `active-win` npm package)

## Karpathy alignment

Each design decision traces to a CLAUDE.md principle:

| Decision | Principle |
|---------|-----------|
| 5 layers, not 8 | Simplicity first |
| Stub Dream/GEPA/etc rather than reimplement now | Surgical changes (only build what user-visible features need) |
| Single dispatch hub instead of 6 schedulers | Simplicity first |
| MCP-first instead of bespoke OS scanners | Don't add abstractions for hypothetical futures (delete the bespoke code, use the protocol) |
| `gate` as middleware not its own layer | Don't add layers when middleware suffices |
| `runtime` concept dropped | Remove duplicates (handler already expresses what runtime did) |
| Build full functional MVP not minimal scaffold | Goal-driven execution (the goal is "running product covering all 8 features") |

## Phase 2 work (next session)

In rough order of ROI:

1. Port Oracle Council (5-narrative portrait synthesis) — biggest user-visible "wow"
2. Port Dream consolidation (memory pruning beyond MVP delete-old)
3. Port GEPA (real trace-mining → mutation proposals + eval gate)
4. Port Personal Evolution (real adaptive prompt injection)
5. Port Skills crystallization (auto-create from repeated patterns)
6. Port Self-Diagnostic (richer health invariants)
7. Build first `anchor-*-mcp` repo (browser-mcp recommended — proves the pattern)
8. Add SSE for live plan-step streaming on `/api/advisor/confirm`
9. Add 70+ invariants suite (port + adapt to anchor-core schema)

Each port is independent — every Phase 2 commit ships one of these and stops.
