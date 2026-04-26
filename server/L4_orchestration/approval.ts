/**
 * L3 — Approval Queue (unified inbox).
 *
 * Any tool call gated by L1 with require_confirmation lands here.
 * User decides via /api/approvals/:id/decide. Bus emits APPROVAL_DECIDED.
 */
import { db, DEFAULT_USER_ID } from "../L0_runtime/db.js";
import { bus } from "./bus.js";

export interface PendingApproval {
  id: string;
  source: string;
  sourceRefId: string;
  actionClass: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export function listPending(): PendingApproval[] {
  const rows = db.prepare(
    "SELECT * FROM approval_queue WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 100"
  ).all(DEFAULT_USER_ID) as any[];
  return rows.map(rowToApproval);
}

export function decide(id: string, approved: boolean, reason?: string): boolean {
  const r = db.prepare(
    "UPDATE approval_queue SET status=?, decided_at=datetime('now'), reason=? WHERE id=? AND user_id=? AND status='pending'"
  ).run(approved ? "approved" : "rejected", reason ?? null, id, DEFAULT_USER_ID);
  if (r.changes === 0) return false;
  bus.publish({ type: "APPROVAL_DECIDED", payload: { id, approved, reason } });
  return true;
}

function rowToApproval(row: any): PendingApproval {
  return {
    id: row.id,
    source: row.source,
    sourceRefId: row.source_ref_id,
    actionClass: row.action_class,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
  };
}
