/**
 * Dream Engine — port from anchor-backend (290 lines → ~130).
 *
 * Runs nightly to consolidate memory. 5 operations:
 *   1. Prune stale      — working > 7d, low-conf episodic > 14d
 *   2. Time normalize   — "tomorrow" → date string (deterministic)
 *   3. Promote recurring — episodic with same tags ≥ 3× → semantic
 *   4. Merge contradictions — LLM-detect conflicting semantics → resolve
 *   5. Enforce capacity — cap memories at MAX (default 200)
 *
 * Dropped from backend (per Simplicity First):
 *   - Forgetting curve / archive / arbitration (`memory/lifecycle.js`) —
 *     separate subsystem, not yet ported. Pruning + capacity cover the basics.
 *   - dream_log table — `logExecution` already audits.
 *   - Skill creation — owned by Skills port (this file would duplicate).
 *   - pickVariant A/B prompt experiments — overkill for personal N=1.
 */
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, DEFAULT_USER_ID, logExecution } from "../../L0_runtime/db.js";
import { text } from "../../L0_runtime/llm-gateway.js";

const MAX_MEMORIES = 200;

export interface DreamStats {
  pruned: number;
  timeNormalized: number;
  promoted: number;
  contradictionsResolved: number;
  capacityRemoved: number;
}

function pruneStale(): number {
  let n = 0;
  n += db.prepare(
    "DELETE FROM memories WHERE user_id=? AND type='working' AND julianday('now') - julianday(created_at) > 7"
  ).run(DEFAULT_USER_ID).changes;
  n += db.prepare(
    "DELETE FROM memories WHERE user_id=? AND type='episodic' AND confidence < 0.5 AND julianday('now') - julianday(created_at) > 14"
  ).run(DEFAULT_USER_ID).changes;
  return n;
}

function normalizeTime(): number {
  const now = new Date();
  const candidates = db.prepare(
    "SELECT id, content FROM memories WHERE user_id=? AND (content LIKE '%tomorrow%' OR content LIKE '%next week%' OR content LIKE '%next month%' OR content LIKE '%this week%')"
  ).all(DEFAULT_USER_ID) as any[];
  let n = 0;
  for (const m of candidates) {
    let c = m.content as string;
    let changed = false;
    if (/\btomorrow\b/i.test(c)) {
      const d = new Date(now); d.setDate(d.getDate() + 1);
      c = c.replace(/\btomorrow\b/gi, d.toISOString().slice(0, 10)); changed = true;
    }
    if (/\bnext week\b/i.test(c)) {
      const d = new Date(now); d.setDate(d.getDate() + 7);
      c = c.replace(/\bnext week\b/gi, `week of ${d.toISOString().slice(0, 10)}`); changed = true;
    }
    if (/\bnext month\b/i.test(c)) {
      const d = new Date(now); d.setMonth(d.getMonth() + 1);
      c = c.replace(/\bnext month\b/gi, d.toISOString().slice(0, 7)); changed = true;
    }
    if (/\bthis week\b/i.test(c)) {
      c = c.replace(/\bthis week\b/gi, `week of ${now.toISOString().slice(0, 10)}`); changed = true;
    }
    if (changed) { db.prepare("UPDATE memories SET content=? WHERE id=?").run(c, m.id); n++; }
  }
  return n;
}

function promoteRecurring(): number {
  const groups = db.prepare(`
    SELECT tags, COUNT(*) as cnt FROM memories
    WHERE user_id=? AND type='episodic'
    GROUP BY tags HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 5
  `).all(DEFAULT_USER_ID) as any[];
  let promoted = 0;
  for (const g of groups) {
    let tags: string[];
    try { tags = JSON.parse(g.tags); } catch { continue; }
    if (!tags.length) continue;
    const tagStr = tags.join(", ");
    const titleLike = `Recurring: ${tagStr.slice(0, 20)}`;
    const exists = db.prepare("SELECT id FROM memories WHERE user_id=? AND type='semantic' AND title LIKE ?")
      .get(DEFAULT_USER_ID, `%${titleLike}%`);
    if (exists) continue;
    const episodes = db.prepare(
      "SELECT content FROM memories WHERE user_id=? AND type='episodic' AND tags=? ORDER BY created_at DESC LIMIT 5"
    ).all(DEFAULT_USER_ID, g.tags) as any[];
    const summary = episodes.map((e: any) => e.content).join(" | ").slice(0, 200);
    db.prepare(
      "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
    ).run(
      nanoid(), DEFAULT_USER_ID, "semantic",
      `Recurring: ${tagStr.slice(0, 30)}`,
      `Pattern across ${g.cnt} episodes: ${summary}`,
      JSON.stringify([...tags, "auto-promoted"]),
      "Dream Engine",
      Math.min(0.95, 0.7 + g.cnt * 0.03),
    );
    promoted++;
  }
  return promoted;
}

const ContradictionsSchema = z.object({
  contradictions: z.array(z.object({
    ids: z.array(z.number()).length(2),
    resolution: z.string(),
  })).default([]),
});

async function mergeContradictions(): Promise<number> {
  const semantics = db.prepare(
    "SELECT id, title, content, confidence FROM memories WHERE user_id=? AND type='semantic' ORDER BY created_at LIMIT 50"
  ).all(DEFAULT_USER_ID) as any[];
  if (semantics.length < 2) return 0;
  const list = semantics.map((m: any, i: number) => `[${i}] "${m.title}": ${m.content} (conf ${m.confidence})`).join("\n");
  const sys = `You analyze memories for contradictions. Two memories contradict if they say opposite things about the same topic. "Prefers email" vs "Now prefers Slack" = contradiction. "Likes morning meetings" vs "Hired a CTO" = NOT a contradiction (different topics). If none, return empty array. Output STRICT JSON only: {"contradictions":[{"ids":[i,j],"resolution":"merged statement"}]}`;
  try {
    const r = await text({ task: "dream_contradictions", system: sys, messages: [{ role: "user", content: `Memories:\n${list}` }], maxTokens: 500 });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return 0;
    const parsed = ContradictionsSchema.parse(JSON.parse(m[0]));
    let merged = 0;
    for (const c of parsed.contradictions) {
      const [oldIdx, newIdx] = c.ids;
      const oldMem = semantics[oldIdx]; const newMem = semantics[newIdx];
      if (!oldMem || !newMem) continue;
      db.prepare("UPDATE memories SET content=? WHERE id=?").run(c.resolution.slice(0, 300), newMem.id);
      db.prepare("DELETE FROM memories WHERE id=?").run(oldMem.id);
      merged++;
    }
    return merged;
  } catch (err: any) {
    console.error("[Dream] contradictions failed:", err.message);
    return 0;
  }
}

function enforceCapacity(): number {
  const c = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE user_id=?").get(DEFAULT_USER_ID) as any)?.c ?? 0;
  if (c <= MAX_MEMORIES) return 0;
  const excess = c - MAX_MEMORIES;
  const r = db.prepare(`
    DELETE FROM memories WHERE id IN (
      SELECT id FROM memories WHERE user_id=?
      ORDER BY
        CASE type WHEN 'working' THEN 0 WHEN 'episodic' THEN 1 WHEN 'semantic' THEN 2 END,
        confidence ASC, created_at ASC
      LIMIT ?
    )
  `).run(DEFAULT_USER_ID, excess);
  return r.changes;
}

export async function runDream(): Promise<DreamStats> {
  console.log("[Dream] consolidation starting...");
  const pruned = pruneStale();
  const timeNormalized = normalizeTime();
  const promoted = promoteRecurring();
  const contradictionsResolved = await mergeContradictions();
  const capacityRemoved = enforceCapacity();
  const stats: DreamStats = { pruned, timeNormalized, promoted, contradictionsResolved, capacityRemoved };
  logExecution("Dream Engine", `pruned=${pruned} normalized=${timeNormalized} promoted=${promoted} merged=${contradictionsResolved} capped=${capacityRemoved}`);
  console.log(`[Dream] done: ${JSON.stringify(stats)}`);
  return stats;
}
