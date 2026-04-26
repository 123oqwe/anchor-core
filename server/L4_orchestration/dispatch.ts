/**
 * L3 — Unified Scheduler Dispatch (cron + workflow + session grain).
 *
 * One hub instead of 6 schedulers. Each schedule entry has a "grain":
 *   - cron:     fires on a cron pattern (node-cron)
 *   - on_event: fires when a specific bus event occurs
 *   - manual:   only fires when explicitly invoked
 *
 * System schedules are wired here; user schedules live in `user_crons`
 * table and get loaded at boot.
 */
import { schedule as cronSchedule } from "node-cron";
import { db, DEFAULT_USER_ID, logExecution } from "../L0_runtime/db.js";
import { writeMemory } from "../L2_memory/memory.js";
import { text } from "../L0_runtime/llm-gateway.js";
import { runDream } from "../L3_cognition/system_agents/dream.js";
import { runDiagnostic } from "../L3_cognition/system_agents/diagnostic.js";
import { runSkillsCrystallize } from "../L3_cognition/system_agents/skills.js";
import { runEvolution } from "../L3_cognition/system_agents/evolution.js";
import { runGEPA } from "../L3_cognition/system_agents/gepa.js";

interface SchedEntry {
  id: string;
  name: string;
  pattern?: string;
  grain: "cron" | "on_event" | "manual";
  enabled: boolean;
  fn: () => Promise<void> | void;
}

const entries: SchedEntry[] = [];

export function registerSchedule(entry: SchedEntry): void {
  entries.push(entry);
  if (entry.grain === "cron" && entry.enabled && entry.pattern) {
    cronSchedule(entry.pattern, async () => {
      try { await entry.fn(); }
      catch (err: any) { console.error(`[Scheduler] ${entry.name} failed:`, err.message); logExecution(entry.name, `failed: ${err.message}`, "failed"); }
    });
  }
}

export function listSchedules(): { id: string; name: string; pattern?: string; grain: string; enabled: boolean }[] {
  return entries.map(e => ({ id: e.id, name: e.name, pattern: e.pattern, grain: e.grain, enabled: e.enabled }));
}

// ── System schedules ──────────────────────────────────────────────

export function registerSystemSchedules(): void {
  // Morning digest — 8am every day
  registerSchedule({
    id: "morning_digest",
    name: "Morning Digest",
    grain: "cron",
    pattern: "0 8 * * *",
    enabled: true,
    fn: async () => {
      const items = db.prepare(
        "SELECT label, status, detail FROM graph_nodes WHERE user_id=? AND status IN ('overdue','delayed','decaying') LIMIT 10"
      ).all(DEFAULT_USER_ID) as any[];
      if (!items.length) return;
      const r = await text({
        task: "morning_digest",
        system: "You are Anchor's morning briefer. Write 3 short bullets — what needs attention today.",
        messages: [{ role: "user", content: items.map((n: any) => `[${n.status}] ${n.label}: ${n.detail}`).join("\n") }],
        maxTokens: 300,
      });
      writeMemory({ type: "working", title: `Morning Digest — ${new Date().toLocaleDateString()}`, content: r.text, source: "morning_digest" });
      logExecution("Morning Digest", "generated");
    },
  });

  // Decay sweep — every 6 hours
  registerSchedule({
    id: "decay_sweep",
    name: "Decay Sweep",
    grain: "cron",
    pattern: "0 */6 * * *",
    enabled: true,
    fn: () => {
      const r = db.prepare(
        "UPDATE graph_nodes SET status='decaying' WHERE user_id=? AND status='active' AND datetime(updated_at) < datetime('now', '-7 days')"
      ).run(DEFAULT_USER_ID);
      if (r.changes > 0) logExecution("Decay Sweep", `marked ${r.changes} nodes as decaying`);
    },
  });

  // Dream Engine — nightly 3am consolidation
  registerSchedule({
    id: "dream",
    name: "Dream Engine",
    grain: "cron",
    pattern: "0 3 * * *",
    enabled: true,
    fn: async () => { await runDream(); },
  });

  // Self-Diagnostic — weekly Sunday 9am
  registerSchedule({
    id: "diagnostic",
    name: "Diagnostic",
    grain: "cron",
    pattern: "0 9 * * 0",
    enabled: true,
    fn: () => { runDiagnostic(); },
  });

  // Skills Crystallization — weekly Sunday 4am (after Dream, before user wakes)
  registerSchedule({
    id: "skills_crystallize",
    name: "Skills Crystallize",
    grain: "cron",
    pattern: "0 4 * * 0",
    enabled: true,
    fn: async () => { await runSkillsCrystallize(); },
  });

  // Personal Evolution — daily 4am (after Dream)
  registerSchedule({
    id: "evolution",
    name: "Personal Evolution",
    grain: "cron",
    pattern: "0 4 * * *",
    enabled: true,
    fn: async () => { await runEvolution(); },
  });

  // GEPA — weekly Sunday 5am (post-Dream/Evolution, mines llm_calls last 7d)
  registerSchedule({
    id: "gepa",
    name: "GEPA Trace Optimizer",
    grain: "cron",
    pattern: "0 5 * * 0",
    enabled: true,
    fn: async () => { await runGEPA(); },
  });

  // User crons (loaded from db)
  const userCrons = db.prepare("SELECT * FROM user_crons WHERE user_id=? AND enabled=1").all(DEFAULT_USER_ID) as any[];
  for (const c of userCrons) {
    registerSchedule({
      id: c.id,
      name: c.name,
      grain: "cron",
      pattern: c.pattern,
      enabled: true,
      fn: async () => {
        // User crons execute as memos by default; richer dispatch (e.g. trigger
        // a custom agent) can be added when triggers per-cron are configured.
        writeMemory({ type: "working", title: `Cron: ${c.name}`, content: c.action, source: `user_cron:${c.id}` });
        logExecution(`Cron:${c.name}`, "fired");
      },
    });
  }
}
