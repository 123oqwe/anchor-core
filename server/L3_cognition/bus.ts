/**
 * L3 — Event bus. Internal pub/sub for orchestration.
 *
 * Events drive the autonomous evolution machinery (Twin learns from
 * USER_CONFIRMED + EXECUTION_DONE; Skills crystallize from repeated patterns;
 * Approval queue from PROPOSAL_PENDING).
 */
import { EventEmitter } from "node:events";

export interface PlanStep { id: number; content: string; tool?: string }
export interface StepChange { type: "kept" | "modified" | "deleted" | "added"; step_id?: number; before?: string; after?: string; content?: string }

export type AnchorEvent =
  | { type: "USER_CONFIRMED"; payload: { sessionId: string; original_steps: PlanStep[]; user_steps: PlanStep[]; changes: StepChange[] } }
  | { type: "EXECUTION_DONE"; payload: { sessionId: string; steps_result: { step: string; status: string; result: string }[]; plan_summary: string } }
  | { type: "TWIN_UPDATED"; payload: { insight: string; category: string } }
  | { type: "GRAPH_UPDATED"; payload: { nodeId: string; status: string; label: string } }
  | { type: "TASK_COMPLETED"; payload: { taskId: string; title: string } }
  | { type: "APPROVAL_DECIDED"; payload: { id: string; approved: boolean; reason?: string } }
  | { type: "MCP_CONNECTED"; payload: { serverId: string; serverName: string; toolCount: number } };

class AnchorBus extends EventEmitter {
  publish(event: AnchorEvent): void {
    console.log(`[Bus] ▶ ${event.type}`, JSON.stringify(event.payload).slice(0, 100));
    this.emit("event", event);
  }
}

export const bus = new AnchorBus();
bus.setMaxListeners(30);
