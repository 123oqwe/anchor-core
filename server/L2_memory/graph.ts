/**
 * L2 Memory — Personal Knowledge Graph (bi-temporal).
 *
 * Domains: people / projects / tasks / values / constraints / preferences /
 *          interests / risks / etc.
 *
 * Bi-temporal: valid_from / valid_to per node and edge → reconstruct any
 * point-in-time view of "what the graph said".
 */
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../L0_runtime/db.js";

export type GraphDomain = "people" | "projects" | "tasks" | "values" | "constraints" | "preferences" | "interests" | "risks" | "health" | "other";

export type GraphNodeType = "person" | "project" | "task" | "value" | "constraint" | "preference" | "interest" | "risk" | "behavioral_pattern";

export interface GraphNode {
  id: string;
  domain: GraphDomain;
  label: string;
  type: GraphNodeType;
  status: string;
  detail: string;
  validFrom: string;
  validTo?: string;
}

export function createNode(input: {
  domain: GraphDomain; label: string; type: GraphNodeType; status?: string; detail?: string;
}): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO graph_nodes (id, user_id, domain, label, type, status, detail) VALUES (?,?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, input.domain, input.label, input.type, input.status ?? "active", input.detail ?? "");
  return id;
}

export function updateNode(id: string, updates: { status?: string; detail?: string }): boolean {
  const sets: string[] = [];
  const args: any[] = [];
  if (updates.status) { sets.push("status=?"); args.push(updates.status); }
  if (updates.detail !== undefined) { sets.push("detail=?"); args.push(updates.detail); }
  if (!sets.length) return false;
  sets.push("updated_at=datetime('now')");
  args.push(id, DEFAULT_USER_ID);
  return db.prepare(`UPDATE graph_nodes SET ${sets.join(", ")} WHERE id=? AND user_id=?`).run(...args).changes > 0;
}

export function closeNode(id: string): void {
  db.prepare("UPDATE graph_nodes SET valid_to=datetime('now'), status='done', updated_at=datetime('now') WHERE id=? AND user_id=?")
    .run(id, DEFAULT_USER_ID);
}

export function getNode(id: string): GraphNode | null {
  const row = db.prepare("SELECT * FROM graph_nodes WHERE id=? AND user_id=?").get(id, DEFAULT_USER_ID) as any;
  return row ? rowToNode(row) : null;
}

export function getNodesByType(type: GraphNodeType, asOf?: string): GraphNode[] {
  const time = asOf ?? new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM graph_nodes
    WHERE user_id=? AND type=?
      AND datetime(valid_from) <= datetime(?)
      AND (valid_to IS NULL OR datetime(valid_to) > datetime(?))
    ORDER BY updated_at DESC
  `).all(DEFAULT_USER_ID, type, time, time) as any[];
  return rows.map(rowToNode);
}

export function getActiveNodes(asOf?: string): GraphNode[] {
  const time = asOf ?? new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM graph_nodes
    WHERE user_id=?
      AND status NOT IN ('done', 'archived')
      AND datetime(valid_from) <= datetime(?)
      AND (valid_to IS NULL OR datetime(valid_to) > datetime(?))
    ORDER BY updated_at DESC LIMIT 50
  `).all(DEFAULT_USER_ID, time, time) as any[];
  return rows.map(rowToNode);
}

export function createEdge(input: { from: string; to: string; type: string; weight?: number }): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, type, weight) VALUES (?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, input.from, input.to, input.type, input.weight ?? 1.0);
  return id;
}

export function serializeGraphForPrompt(asOf?: string): string {
  const nodes = getActiveNodes(asOf);
  if (!nodes.length) return "";

  const byDomain = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!byDomain.has(n.domain)) byDomain.set(n.domain, []);
    byDomain.get(n.domain)!.push(n);
  }

  const lines = ["KNOWLEDGE GRAPH (active items):"];
  for (const [domain, items] of byDomain.entries()) {
    lines.push(`${domain.toUpperCase()}:`);
    for (const n of items.slice(0, 10)) {
      lines.push(`  - [${n.status}] ${n.label}: ${n.detail.slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}

export function buildValueConstitution(): string {
  const values = getNodesByType("value");
  const constraints = getNodesByType("constraint");
  const preferences = getNodesByType("preference");
  if (!values.length && !constraints.length && !preferences.length) return "";

  const lines = ["USER VALUE CONSTITUTION (respect in every recommendation):"];
  if (values.length) {
    lines.push("VALUES:");
    for (const v of values) lines.push(`  - ${v.label}: ${v.detail}`);
  }
  if (constraints.length) {
    lines.push("CONSTRAINTS (never violate):");
    for (const c of constraints) lines.push(`  - ${c.label}: ${c.detail}`);
  }
  if (preferences.length) {
    lines.push("PREFERENCES:");
    for (const p of preferences) lines.push(`  - ${p.label}: ${p.detail}`);
  }
  lines.push("HIERARCHY: Safety > Values > Constraints > Preferences > Efficiency");
  return lines.join("\n");
}

function rowToNode(row: any): GraphNode {
  return {
    id: row.id,
    domain: row.domain,
    label: row.label,
    type: row.type,
    status: row.status,
    detail: row.detail,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
  };
}
