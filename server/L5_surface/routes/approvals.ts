/**
 * /api/approvals — Approval queue.
 */
import { Router } from "express";
import { listPending, decide } from "../../L4_orchestration/approval.js";

const router = Router();

router.get("/", (_req, res) => res.json(listPending()));

router.post("/:id/decide", (req, res) => {
  const { approved, reason } = req.body ?? {};
  if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
  const ok = decide(req.params.id, approved, reason);
  res.json({ ok });
});

export default router;
