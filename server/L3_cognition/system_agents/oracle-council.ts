/**
 * Oracle Council — port from anchor-backend (395 lines → 160).
 *
 * 5 oracles each look at the user's graph + memories + twin insights through
 * a distinct lens, produce a 150-250 word narrative + 1-3 questions. A 6th
 * Compass synthesizes into headline + paragraph + 3 questions.
 *
 * Differences from anchor-backend version (per Karpathy "Simplicity first"):
 *   - No InferredProfile / profile-inference dependency. We feed graph +
 *     memories + twin directly. Each oracle's lens does the interpretation.
 *   - No PORTRAIT_PROGRESS streaming events (UI doesn't exist yet).
 *   - No computeRhythmFingerprint (timeline data not yet ported).
 *   - 1 file vs 2 (no system_agents split).
 *
 * Same as backend (the essence):
 *   - 5 lens prompts ported verbatim (they're the soul of this feature).
 *   - Parallel oracle execution.
 *   - Compass synthesis prompt + JSON shape.
 *   - portraits table + version bump on persist.
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../../L0_runtime/db.js";
import { text } from "../../L0_runtime/llm-gateway.js";
import { serializeGraphForPrompt, getNodesByType } from "../../L2_memory/graph.js";
import { recentMemories, getTwinInsights, serializeTwinForPrompt } from "../../L2_memory/memory.js";

export type OracleId = "historian" | "cartographer" | "purpose" | "shadow" | "tempo";

export interface OracleNarrative {
  oracle: OracleId;
  displayName: string;
  icon: string;
  narrative: string;
  questions: string[];
  durationMs: number;
}

export interface Compass {
  headline: string;
  paragraph: string;
  three_questions: string[];
}

export interface PortraitV1 {
  oracles: OracleNarrative[];
  compass: Compass;
  generatedAt: string;
}

interface OracleDef { id: OracleId; displayName: string; icon: string; lens: string }

const ORACLES: OracleDef[] = [
  {
    id: "historian", displayName: "Historian", icon: "📜",
    lens: "You are the Historian Oracle. You read the user's graph + memories as ARTIFACTS of a longer biographical arc. Your question is not 'what is the user doing now' — it is 'what chapter of their life is this, and what chapter is ending or starting?'. Notice which interests/projects are recent vs long-running, what evidence hints at a present transition, what migration / role-change story emerges. Cite SPECIFIC node labels from the graph slice. Warm but precise. Notice what's ending as much as what's beginning.",
  },
  {
    id: "cartographer", displayName: "Cartographer", icon: "🗺️",
    lens: "You are the Cartographer Oracle. You map the user's relationship topology: who is close, who is drifting, who is transactional, who is missing. Read the people nodes in the graph slice. CITE SPECIFIC NAMES — do not paraphrase them away. Look for ASYMMETRIES: who initiates vs responds, who appears in projects vs who appears in personal context. Notice the SIZE of the close-in circle vs wider network. Flag when someone's role might be wrong and invite the user to correct.",
  },
  {
    id: "purpose", displayName: "Purpose", icon: "🎯",
    lens: "You are the Purpose Oracle. Compare what the user SAYS they're doing (primary identity / values / stated goals) against what their ARTIFACTS show (active projects, interests, recent tasks). Find the gap between STATED purpose and BEHAVED purpose. If the graph shows multiple competing pulls (e.g. work + side hobby + new interest), name them directly and ask which is the true north. Reframe what they're actually building using a precise word they may not have used. Blunt but respectful. Never preach about priorities.",
  },
  {
    id: "shadow", displayName: "Shadow", icon: "🌗",
    lens: "You are the Shadow Oracle. Surface what the user is AVOIDING or NOT SEEING. Read ABSENCE patterns — domains in the graph that look unusually thin, dormant projects, twin contraindications they keep editing back. If a hobby competes with a demanding primary role, the shadow may be: the hobby is the escape from the thing that matters most. Gentle but honest — do not shame, do not protect. If evidence is thin, say 'I might be wrong here' and ask a question instead.",
  },
  {
    id: "tempo", displayName: "Tempo", icon: "⏱️",
    lens: "You are the Tempo Oracle. You read the user's work rhythm — when they are sharp, scattered, what breaks their flow. Look at memory timestamps and recent activity patterns. Flag ritual vs. chaotic rhythms, sustainability vs. overload. Do not prescribe wellness — describe the rhythm and ask whether it serves the person.",
  },
];

const OUTPUT_SHAPE = `OUTPUT — strict JSON only (no preamble, no markdown):
{"narrative":"150-250 words, second-person ('you'), evidence-based, specific. Must cite at least one specific identifier from the slice (a node label, person name, project, etc).","questions":["1-3 probing open-ended questions that invite the user to CORRECT or CONFIRM"]}`;

function buildContextSlice(): string {
  // Same slice for all oracles. Each oracle's lens determines what to focus on.
  // (Anchor-backend pre-sliced per oracle; we don't have InferredProfile, so we
  // give the whole graph + recent memories + twin insights to every oracle.)
  const parts: string[] = [];
  parts.push(serializeGraphForPrompt());
  const mem = recentMemories({ limit: 20 });
  if (mem.length) {
    parts.push("RECENT MEMORIES:");
    for (const m of mem) parts.push(`  - [${m.type}] ${m.title}: ${m.content.slice(0, 200)}`);
  }
  parts.push(serializeTwinForPrompt(getTwinInsights(15)));
  // Active interests as quick summary
  const interests = getNodesByType("interest");
  if (interests.length) parts.push(`ACTIVE INTERESTS: ${interests.map(i => i.label).join(" | ")}`);
  return parts.filter(Boolean).join("\n\n");
}

async function runOracle(def: OracleDef, contextSlice: string): Promise<OracleNarrative> {
  const start = Date.now();
  const system = `${def.lens}\n\n${OUTPUT_SHAPE}`;
  let narrative = "(Oracle returned no narrative)";
  let questions: string[] = [];
  try {
    const r = await text({
      task: `oracle_${def.id}`,
      system,
      messages: [{ role: "user", content: `Here is the slice:\n\n${contextSlice}\n\nProduce your JSON output now.` }],
      maxTokens: 1200,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (typeof parsed.narrative === "string" && parsed.narrative.length > 20) narrative = parsed.narrative.trim();
      if (Array.isArray(parsed.questions)) questions = parsed.questions.filter((q: any) => typeof q === "string").slice(0, 3);
    }
  } catch (err: any) {
    console.error(`[Oracle:${def.displayName}] failed:`, err.message);
  }
  return { oracle: def.id, displayName: def.displayName, icon: def.icon, narrative, questions, durationMs: Date.now() - start };
}

async function runCompass(oracles: OracleNarrative[]): Promise<Compass> {
  const system = `You are the Compass — synthesize the 5 Oracle narratives into one coherent portrait.
OUTPUT — strict JSON only:
{"headline":"ONE sentence capturing who this person is right now. Specific, not generic. Under 30 words.","paragraph":"3-5 sentences weaving the Oracles' strongest points. Must surface a TENSION or reframe at least once. Do not list Oracles; integrate.","three_questions":["The 3 most important questions that would unlock the next phase. Order by leverage."]}`;
  const user = ["Oracle narratives:", ...oracles.map(o => `[${o.displayName}] ${o.narrative}\nquestions: ${o.questions.join(" // ")}`)].join("\n---\n");
  try {
    const r = await text({ task: "oracle_compass", system, messages: [{ role: "user", content: user }], maxTokens: 1000 });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      return {
        headline: typeof parsed.headline === "string" ? parsed.headline.trim() : "(Compass parse failed)",
        paragraph: typeof parsed.paragraph === "string" ? parsed.paragraph.trim() : "",
        three_questions: Array.isArray(parsed.three_questions) ? parsed.three_questions.slice(0, 3) : [],
      };
    }
  } catch (err: any) {
    console.error("[Oracle:Compass] failed:", err.message);
  }
  return { headline: "(Compass output could not be parsed)", paragraph: "", three_questions: [] };
}

export async function runOracleCouncil(opts?: { persist?: boolean }): Promise<PortraitV1> {
  const slice = buildContextSlice();
  console.log(`[OracleCouncil] dispatching ${ORACLES.length} oracles in parallel...`);
  const oracleStart = Date.now();
  const oracles = await Promise.all(ORACLES.map(def => runOracle(def, slice)));
  oracles.sort((a, b) => ORACLES.findIndex(o => o.id === a.oracle) - ORACLES.findIndex(o => o.id === b.oracle));
  console.log(`[OracleCouncil] 5 oracles done in ${Date.now() - oracleStart}ms. Compass...`);
  const compass = await runCompass(oracles);
  const portrait: PortraitV1 = { oracles, compass, generatedAt: new Date().toISOString() };
  if (opts?.persist !== false) persistPortrait(portrait);
  return portrait;
}

function persistPortrait(p: PortraitV1): string {
  const id = nanoid();
  const latest = db.prepare("SELECT version FROM portraits WHERE user_id=? ORDER BY version DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
  const nextVersion = (latest?.version ?? 0) + 1;
  db.prepare("INSERT INTO portraits (id, user_id, version, data_json) VALUES (?,?,?,?)").run(id, DEFAULT_USER_ID, nextVersion, JSON.stringify(p));
  console.log(`[OracleCouncil] persisted portrait v${nextVersion}`);
  return id;
}

export function getLatestPortrait(): PortraitV1 | null {
  const row = db.prepare("SELECT data_json FROM portraits WHERE user_id=? ORDER BY version DESC LIMIT 1").get(DEFAULT_USER_ID) as any;
  if (!row) return null;
  try { return JSON.parse(row.data_json); } catch { return null; }
}
