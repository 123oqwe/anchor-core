/**
 * L2 Memory — episodic / semantic / working with FTS5-backed retrieval.
 *
 * Three memory types:
 *   - episodic:  what happened ("user confirmed plan X at time Y")
 *   - semantic:  generalized knowledge ("user prefers morning meetings")
 *   - working:   short-lived scratch (digests, recent state)
 *
 * Bi-temporal: every row has valid_from / valid_to so we can reconstruct
 * "what did anchor know at point T".
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../L0_runtime/db.js";

export type MemoryType = "episodic" | "semantic" | "working";

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  validFrom: string;
  validTo?: string;
  createdAt: string;
}

export function writeMemory(input: {
  type: MemoryType;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
  confidence?: number;
}): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO memories (id, user_id, type, title, content, tags, source, confidence) VALUES (?,?,?,?,?,?,?,?)"
  ).run(
    id, DEFAULT_USER_ID, input.type, input.title, input.content,
    JSON.stringify(input.tags ?? []), input.source ?? "", input.confidence ?? 0.8,
  );
  return id;
}

export function writeTwinInsight(input: {
  category: string; insight: string; confidence: number; contraindication?: string; source?: string;
}): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO twin_insights (id, user_id, category, insight, confidence, contraindication, source) VALUES (?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, input.category, input.insight, input.confidence, input.contraindication ?? null, input.source ?? "edits");
  return id;
}

export function searchMemoryFTS(query: string, limit = 10): MemoryRecord[] {
  // Sanitize FTS query — strip operators, quote phrases
  const safe = query.replace(/['"]/g, " ").trim();
  if (!safe) return [];
  try {
    const rows = db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.rowid = f.rowid
      WHERE f.memories_fts MATCH ?
        AND m.user_id = ?
        AND (m.valid_to IS NULL OR datetime(m.valid_to) > datetime('now'))
      ORDER BY rank LIMIT ?
    `).all(safe, DEFAULT_USER_ID, limit) as any[];
    return rows.map(rowToMemory);
  } catch {
    return [];
  }
}

export function recentMemories(opts?: { type?: MemoryType; limit?: number }): MemoryRecord[] {
  const limit = opts?.limit ?? 20;
  const where = opts?.type ? "AND type=?" : "";
  const args: any[] = [DEFAULT_USER_ID];
  if (opts?.type) args.push(opts.type);
  args.push(limit);
  const rows = db.prepare(
    `SELECT * FROM memories WHERE user_id=? ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...args) as any[];
  return rows.map(rowToMemory);
}

export function getTwinInsights(limit = 20): { category: string; insight: string; confidence: number; contraindication: string | null }[] {
  return db.prepare(
    "SELECT category, insight, confidence, contraindication FROM twin_insights WHERE user_id=? ORDER BY created_at DESC LIMIT ?"
  ).all(DEFAULT_USER_ID, limit) as any[];
}

export function serializeMemoriesForPrompt(records: MemoryRecord[]): string {
  if (records.length === 0) return "";
  const lines = ["RELEVANT MEMORY:"];
  for (const m of records) {
    lines.push(`- [${m.type}] ${m.title}: ${m.content.slice(0, 200)}`);
  }
  return lines.join("\n");
}

export function serializeTwinForPrompt(insights: ReturnType<typeof getTwinInsights>): string {
  if (insights.length === 0) return "";
  const lines = ["TWIN INSIGHTS (what the user has taught us by editing/accepting/rejecting):"];
  for (const i of insights) {
    if (i.contraindication) lines.push(`- AVOID: ${i.contraindication} (${i.category}, conf ${i.confidence})`);
    else lines.push(`- ${i.insight} (${i.category}, conf ${i.confidence})`);
  }
  return lines.join("\n");
}

function rowToMemory(row: any): MemoryRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags || "[]"),
    source: row.source,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
    createdAt: row.created_at,
  };
}
