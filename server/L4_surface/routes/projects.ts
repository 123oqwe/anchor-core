/**
 * /api/projects — Workspace projects (with state JSON for agent context).
 */
import { Router } from "express";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../../L0_runtime/db.js";

const router = Router();

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC").all(DEFAULT_USER_ID) as any[];
  res.json(rows.map(rowToProject));
});

router.post("/", (req, res) => {
  const { name, goal, state, nextCheckIn } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const id = nanoid();
  db.prepare(
    "INSERT INTO projects (id, user_id, name, goal, state_json, next_check_in) VALUES (?,?,?,?,?,?)"
  ).run(id, DEFAULT_USER_ID, name, goal ?? "", JSON.stringify(state ?? {}), nextCheckIn ?? null);
  res.json({ id });
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(rowToProject(row));
});

router.put("/:id", (req, res) => {
  const { name, goal, status, nextCheckIn } = req.body ?? {};
  const sets: string[] = []; const args: any[] = [];
  if (name !== undefined) { sets.push("name=?"); args.push(name); }
  if (goal !== undefined) { sets.push("goal=?"); args.push(goal); }
  if (status !== undefined) { sets.push("status=?"); args.push(status); }
  if (nextCheckIn !== undefined) { sets.push("next_check_in=?"); args.push(nextCheckIn); }
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at=datetime('now')");
  args.push(req.params.id, DEFAULT_USER_ID);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id=? AND user_id=?`).run(...args);
  res.json({ ok: true });
});

router.put("/:id/state", (req, res) => {
  const { merge, state } = req.body ?? {};
  const row = db.prepare("SELECT state_json FROM projects WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const current = JSON.parse(row.state_json);
  const next = merge ? { ...current, ...state } : state;
  db.prepare("UPDATE projects SET state_json=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
    .run(JSON.stringify(next), req.params.id, DEFAULT_USER_ID);
  res.json({ id: req.params.id, state: next });
});

function rowToProject(row: any) {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    status: row.status,
    state: JSON.parse(row.state_json || "{}"),
    nextCheckIn: row.next_check_in,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default router;
