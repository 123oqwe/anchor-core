/**
 * Skills Crystallization — port from anchor-backend (311 lines → ~110).
 *
 * The "evolution" mechanism: detect repeated confirmed plans → auto-create
 * a reusable skill row. Runtime preemption (detectSkillMatch / buildSkillBasedPlan)
 * is a separate optimization — not ported here. Crystallization is the loop.
 *
 * Anchor-core source: action_sessions (status='done') grouped by plan_summary.
 * (Anchor-backend used `messages` + draft_status which we don't have.)
 *
 * Dropped (Karpathy):
 *   - detectSkillMatch / buildSkillBasedPlan — runtime preemption, separate feature
 *   - evolveSkill / penalizeSkill — needs rejection signals (no satisfaction_signals)
 *   - context_conditions (energy/focus/stress) — no user_state in anchor-core MVP
 *   - getConfig/setConfig threshold tuning — no system_config
 */
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, DEFAULT_USER_ID, logExecution } from "../../L0_runtime/db.js";
import { text } from "../../L0_runtime/llm-gateway.js";

const MIN_REPETITIONS = 3;     // need 3+ similar confirmed plans
const LOOKBACK_DAYS = 30;

const SkillExtractSchema = z.object({
  detected: z.boolean(),
  name: z.string().default(""),
  description: z.string().default(""),
  steps: z.array(z.string()).default([]),
  trigger: z.string().default(""),
});

export interface CrystallizeResult { created: number; candidates: number; skills: { id: string; name: string }[] }

export async function runSkillsCrystallize(): Promise<CrystallizeResult> {
  // Find clusters of done sessions sharing a plan_summary
  const clusters = db.prepare(`
    SELECT plan_summary, COUNT(*) as n FROM action_sessions
    WHERE user_id=? AND status='done' AND datetime(started_at) > datetime('now', ?)
    GROUP BY plan_summary HAVING n >= ?
    ORDER BY n DESC LIMIT 10
  `).all(DEFAULT_USER_ID, `-${LOOKBACK_DAYS} days`, MIN_REPETITIONS) as any[];

  if (clusters.length === 0) {
    logExecution("Skills", "no crystallization candidates");
    return { created: 0, candidates: 0, skills: [] };
  }

  const created: { id: string; name: string }[] = [];

  for (const cluster of clusters) {
    // Skip if already crystallized for this summary
    const existing = db.prepare(
      "SELECT id FROM skills WHERE user_id=? AND trigger_pattern LIKE ?"
    ).get(DEFAULT_USER_ID, `%${cluster.plan_summary.slice(0, 30)}%`);
    if (existing) continue;

    // Pull canonical steps from the most recent done session of this cluster
    const recent = db.prepare(
      "SELECT id FROM action_sessions WHERE user_id=? AND plan_summary=? AND status='done' ORDER BY started_at DESC LIMIT 1"
    ).get(DEFAULT_USER_ID, cluster.plan_summary) as any;
    if (!recent) continue;

    const steps = db.prepare(
      "SELECT content FROM action_steps WHERE session_id=? ORDER BY step_index"
    ).all(recent.id) as any[];
    if (steps.length === 0) continue;

    const stepsList = steps.map((s, i) => `${i + 1}. ${s.content}`).join("\n");

    // LLM gate: is this actually a reusable pattern?
    let parsed: z.infer<typeof SkillExtractSchema> | null = null;
    try {
      const r = await text({
        task: "skill_crystallize",
        system: `You evaluate whether a recurring plan should be saved as a reusable skill template.
A skill MUST: have clear repeatable steps, have a recognizable trigger pattern in the user's request, not be a one-off.
If yes, propose a name + 1-line description + canonical steps + a short trigger pattern (3-5 keywords separated by '|').
If not, set "detected" to false.
Output STRICT JSON only:
{"detected":true|false,"name":"","description":"","steps":["..."],"trigger":"keyword|keyword|keyword"}`,
        messages: [{
          role: "user",
          content: `Plan summary: "${cluster.plan_summary}"\nObserved ${cluster.n} times in last ${LOOKBACK_DAYS} days.\nCanonical steps:\n${stepsList}`,
        }],
        maxTokens: 400,
      });
      const m = r.text.match(/\{[\s\S]*\}/);
      if (m) parsed = SkillExtractSchema.parse(JSON.parse(m[0]));
    } catch (err: any) {
      console.error("[Skills] LLM gate failed:", err.message);
    }

    if (!parsed?.detected || !parsed.name || parsed.steps.length === 0) continue;

    // Avoid name collision
    const nameClash = db.prepare("SELECT id FROM skills WHERE user_id=? AND name=?").get(DEFAULT_USER_ID, parsed.name);
    if (nameClash) continue;

    const id = nanoid();
    db.prepare(
      "INSERT INTO skills (id, user_id, name, description, steps_json, trigger_pattern) VALUES (?,?,?,?,?,?)"
    ).run(id, DEFAULT_USER_ID, parsed.name, parsed.description || `Crystallized from ${cluster.n} done plans`, JSON.stringify(parsed.steps), parsed.trigger);
    created.push({ id, name: parsed.name });
    console.log(`[Skills] crystallized "${parsed.name}" from ${cluster.n} sessions`);
  }

  logExecution("Skills", `${created.length} crystallized from ${clusters.length} candidate cluster(s)`);
  return { created: created.length, candidates: clusters.length, skills: created };
}
