/**
 * L1 Tools — Permission gate (was L6 in old anchor; merged in here as middleware).
 *
 * Action classes carry trust levels. High-trust auto-allowed. Low-trust
 * requires user confirmation (writes to approval_queue). Denied classes
 * fail outright.
 */

export type ActionClass =
  | "read_memory"        // safe: read graph / memory / files
  | "write_memory"       // medium: insert into memories / graph
  | "write_task"         // medium: create/update tasks
  | "write_graph"        // medium: mutate knowledge graph
  | "execute_code"       // medium: run sandboxed code
  | "send_external"      // high: anything that touches the outside world (email, message, API write)
  | "destructive";       // critical: delete data, drop tables, etc.

export type GateDecision = "allow" | "deny" | "require_confirmation";

export interface GateInput {
  actionClass: ActionClass;
  description: string;
  source: "user_triggered" | "cron" | "agent_chain";
}

export interface GateResult {
  decision: GateDecision;
  reason?: string;
}

// Default policy. Pre-launch defaults: be permissive for read, careful for
// external. Trust model evolves over time via record{Success,Failure}.
const DEFAULT_POLICY: Record<ActionClass, GateDecision> = {
  read_memory: "allow",
  write_memory: "allow",
  write_task: "allow",
  write_graph: "allow",
  execute_code: "require_confirmation",
  send_external: "require_confirmation",
  destructive: "deny",
};

const trustScore = new Map<ActionClass, number>();

export function checkPermission(input: GateInput): GateResult {
  const decision = DEFAULT_POLICY[input.actionClass] ?? "require_confirmation";

  // Cron-triggered actions get one notch stricter (no silent external sends).
  if (input.source === "cron" && (input.actionClass === "send_external" || input.actionClass === "execute_code")) {
    return { decision: "require_confirmation", reason: `cron-triggered ${input.actionClass}` };
  }

  if (decision === "allow") return { decision: "allow" };
  if (decision === "deny") return { decision: "deny", reason: `class ${input.actionClass} denied by policy` };
  return { decision: "require_confirmation", reason: `class ${input.actionClass} requires confirmation` };
}

export function recordSuccess(cls: ActionClass): void {
  trustScore.set(cls, (trustScore.get(cls) ?? 0) + 1);
}

export function recordFailure(cls: ActionClass): void {
  trustScore.set(cls, Math.max(0, (trustScore.get(cls) ?? 0) - 2));
}

export function getTrustReport(): Record<string, number> {
  return Object.fromEntries(trustScore.entries());
}
