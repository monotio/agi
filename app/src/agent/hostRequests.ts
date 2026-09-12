/**
 * The worker's host-service protocol. A host request travels as an ordinary
 * worker message — the worker posts { type: "hostRequest" } and resumes the
 * parked interaction when { type: "hostAnswer" } arrives, so the application
 * stays live while the game waits. Key waits never leave the worker at all:
 * a queued key message answers them directly, and pause/resume is a message
 * too — no shared memory anywhere.
 *
 * Ops the worker may request. Room preparation goes to the agent; getnum /
 * getstring / restore and the save services are host features (blocking user
 * prompt, saved-game lookup) and are intercepted before the agent ever sees
 * them.
 */
export interface LlmRequest {
  op: "room" | "getnum" | "getstring" | "restore" | "saveList" | "saveWrite" | "saveDescription";
  context: Record<string, unknown>;
}

export interface AgentHandler {
  handle(req: LlmRequest): Promise<string>;
}

export type AgentEventSink = (
  kind: "request" | "response" | "error" | "log" | "telemetry",
  detail: string,
  data?: unknown,
) => void;
