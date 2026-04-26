/**
 * /api/cron — list system + user crons; CRUD user crons.
 */
import { Router } from "express";
import { nanoid } from "nanoid";
import { db, DEFAULT_USER_ID } from "../../L0_runtime/db.js";
import { listSchedules } from "../../L3_cognition/dispatch.js";

const router = Router();

router.get("/", (_req, res) => {
  const userCrons = db.prepare("SELECT * FROM user_crons WHERE user_id=? ORDER BY created_at").all(DEFAULT_USER_ID);
  res.json({ system: listSchedules(), user: userCrons });
});

router.post("/", (req, res) => {
  const { name, pattern, action, config } = req.body ?? {};
  if (!name || !pattern || !action) return res.status(400).json({ error: "name + pattern + action required" });
  const id = nanoid();
  db.prepare("INSERT INTO user_crons (id, user_id, name, pattern, action, config_json) VALUES (?,?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, name, pattern, action, JSON.stringify(config ?? {}));
  res.json({ id, note: "Restart server to activate (dispatch loads on boot)" });
});

router.delete("/:id", (req, res) => {
  const r = db.prepare("DELETE FROM user_crons WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: r.changes > 0 });
});

export default router;
