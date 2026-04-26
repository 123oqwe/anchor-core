/**
 * L4 — Event handlers wire bus events to cognition reactions.
 *
 * USER_CONFIRMED → SessionRunner kicks off + Twin learns from edits
 * EXECUTION_DONE → Twin learns from results
 * MCP_CONNECTED  → log notification
 *
 * This is the heart of "autonomous evolution" — every event turns into
 * a learning opportunity.
 */
import { bus } from "./bus.js";
import { startSession } from "./session-runner.js";
import { twinLearnFromEdits, twinLearnFromResults } from "../L3_cognition/twin.js";
import { logExecution } from "../L0_runtime/db.js";

export function wireHandlers(): void {
  bus.on("event", async (event) => {
    try {
      switch (event.type) {
        case "USER_CONFIRMED": {
          // Sidecar: Twin learns asynchronously
          twinLearnFromEdits(event.payload.changes).catch(err => console.error("[Twin Sidecar]", err.message));
          // Main: SessionRunner takes over
          await startSession(event.payload.sessionId);
          break;
        }
        case "EXECUTION_DONE": {
          twinLearnFromResults(event.payload).catch(err => console.error("[Twin Sidecar]", err.message));
          break;
        }
        case "MCP_CONNECTED": {
          logExecution("MCP Host", `connected ${event.payload.serverName} → ${event.payload.toolCount} tools`);
          break;
        }
      }
    } catch (err: any) {
      console.error(`[Handlers] error in ${event.type}:`, err.message);
    }
  });
}
