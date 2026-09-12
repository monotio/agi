/**
 * Main-thread side of the engine worker's shared buffer.
 *
 * The SharedArrayBuffer now carries a single i32 slot: the remix pause flag.
 * Host requests (prompts, save slots, restore, room authoring) travel as
 * ordinary worker messages — the worker posts { type: "hostRequest" } and
 * resumes the parked interaction when { type: "hostAnswer" } arrives, so the
 * application stays live while the game waits. Key waits never leave the
 * worker at all: a queued key message answers them directly.
 *
 * The pause slot still uses the shared buffer because the main thread must
 * freeze the interpreter at the very next cycle boundary — a postMessage
 * would arrive too late. The worker polls the slot at the top of its cycle
 * callback and skips the cycle while it is set. Why not Atomics.wait: while
 * the worker is parked it cannot service any message, and a paused game is
 * exactly when the agent needs to read frames, objects, state and apply
 * patches. The interpreter is untouched between cycles, so resuming
 * continues from the identical state — the freeze is a parked cycle, not a
 * saved one.
 */
/**
 * Ops the worker may request as host-service messages. Room preparation goes
 * to the agent; getnum / getstring / restore and the save services are host
 * features (blocking user prompt, saved-game lookup) and are intercepted
 * before the agent ever sees them.
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

export interface Bridge {
  sab: SharedArrayBuffer;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  dispose(): void;
}

/** Header size in bytes: four i32 slots; only the pause slot is live. */
export const BRIDGE_HEADER_BYTES = 16;
/** i32 index of the remix pause slot. */
export const BRIDGE_PAUSE_SLOT = 2;

export function createBridge(): Bridge {
  const sab = new SharedArrayBuffer(BRIDGE_HEADER_BYTES);
  const i32 = new Int32Array(sab, 0, 4);

  return {
    sab,
    /** Freeze / unfreeze the interpreter between cycles (remix mode). */
    setPaused(paused: boolean): void {
      Atomics.store(i32, BRIDGE_PAUSE_SLOT, paused ? 1 : 0);
      Atomics.notify(i32, BRIDGE_PAUSE_SLOT);
    },
    isPaused(): boolean {
      return Atomics.load(i32, BRIDGE_PAUSE_SLOT) === 1;
    },
    dispose(): void {
      Atomics.store(i32, BRIDGE_PAUSE_SLOT, 0);
    },
  };
}
