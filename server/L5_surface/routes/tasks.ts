/**
 * /api/tasks — Workspace tasks.
 */
import { Router } from "express";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../../L0_runtime/db.js";

const router = Router();

router.get("/", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
  const where: string[] = ["user_id=?"]; const args: any[] = [DEFAULT_USER_ID];
  if (status) { where.push("status=?"); args.push(status); }
  if (projectId) { where.push("project_id=?"); args.push(projectId); }
  const rows = db.prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC`).all(...args) as any[];
  res.json(rows.map(r => ({ ...r, tags: JSON.parse(r.tags || "[]") })));
});

router.post("/", (req, res) => {
  const { title, priority, projectId } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title required" });
  const id = nanoid();
  db.prepare("INSERT INTO tasks (id, user_id, project_id, title, status, priority, tags) VALUES (?,?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, projectId ?? null, title, "todo", priority ?? "medium", JSON.stringify(["manual"]));
  res.json({ id });
});

router.put("/:id", (req, res) => {
  const { status, title } = req.body ?? {};
  const sets: string[] = []; const args: any[] = [];
  if (status) { sets.push("status=?"); args.push(status); }
  if (title) { sets.push("title=?"); args.push(title); }
  if (!sets.length) return res.json({ ok: true });
  args.push(req.params.id, DEFAULT_USER_ID);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=? AND user_id=?`).run(...args);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const r = db.prepare("DELETE FROM tasks WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: r.changes > 0 });
});

export default router;
