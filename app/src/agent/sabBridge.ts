/**
 * Main-thread side of the LLM blocking bridge.
 *
 * SharedArrayBuffer layout (header of four i32 slots, then the payload):
 *   i32[0]  state: 0 idle, 1 request (worker), 2 response ready, 3 in-progress
 *   i32[1]  payload byte length
 *   i32[2]  pause: 0 running, 1 the interpreter parks between cycles
 *   i32[3]  reserved
 *   bytes   JSON request / text response, from BRIDGE_HEADER_BYTES on
 *
 * The engine worker blocks in Atomics.wait on slot 0 while the agent here
 * answers. Slot 2 is the remix freeze: the
 * main thread stores it synchronously, so the worker sees the pause at the
 * very next cycle boundary without waiting for a postMessage to be delivered.
 *
 * Why the worker does NOT Atomics.wait on slot 2: while it is parked in a
 * blocking wait it cannot service any message, and a paused game is exactly
 * when the agent needs to read frames, objects, state and apply patches. So
 * the worker checks the slot at the top of its cycle callback and skips the
 * cycle. The interpreter is untouched between cycles, so resuming continues
 * from the identical state — the freeze is a parked cycle, not a saved one.
 */
/**
 * Ops crossing the bridge. Room preparation goes to the agent; getnum /
 * getstring / restore are host services (blocking user prompt, saved-game
 * lookup) and are intercepted before the agent ever sees them.
 */
export interface LlmRequest {
  // "waitkey" is host-served (a have.key busy loop parks the worker on the
  // bridge until the player presses a key); it never reaches a game agent.
  op:
    | "room"
    | "getnum"
    | "getstring"
    | "restore"
    | "waitkey"
    | "saveList"
    | "saveWrite"
    | "saveDescription";
  context: Record<string, unknown>;
}

export interface AgentHandler {
  handle(req: LlmRequest): Promise<string>;
}

export type AgentEventSink = (
  kind: "request" | "response" | "error" | "log",
  detail: string,
  data?: unknown,
) => void;

export interface Bridge {
  sab: SharedArrayBuffer;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  cancel(): void;
  dispose(): void;
}

/** Header size in bytes: four i32 slots before the payload region. */
export const BRIDGE_HEADER_BYTES = 16;
/** i32 index of the remix pause slot. */
export const BRIDGE_PAUSE_SLOT = 2;

export const BRIDGE_STATE_IDLE = 0;
export const BRIDGE_STATE_REQUEST = 1;
export const BRIDGE_STATE_RESPONSE = 2;
export const BRIDGE_STATE_CLAIMED = 3;
export const BRIDGE_STATE_CANCELLED = 4;

export function createBridge(handler: AgentHandler, onEvent: AgentEventSink): Bridge {
  const sab = new SharedArrayBuffer(BRIDGE_HEADER_BYTES + 4 * 1024 * 1024);
  const i32 = new Int32Array(sab, 0, 4);
  const bytes = new Uint8Array(sab, BRIDGE_HEADER_BYTES);

  const timer = setInterval(() => {
    if (Atomics.load(i32, 0) !== BRIDGE_STATE_REQUEST) return;
    const len = Atomics.load(i32, 1);
    const req = JSON.parse(new TextDecoder().decode(bytes.slice(0, len))) as LlmRequest;
    Atomics.store(i32, 0, BRIDGE_STATE_CLAIMED); // claimed
    onEvent("request", `${req.op} ${JSON.stringify(req.context)}`);
    handler
      .handle(req)
      .then((result) => {
        if (Atomics.load(i32, 0) === BRIDGE_STATE_CANCELLED) return;
        respond(result);
        onEvent("response", result.slice(0, 120));
      })
      .catch((e) => {
        if (Atomics.load(i32, 0) === BRIDGE_STATE_CANCELLED) return;
        respond("");
        onEvent("response", `agent error: ${String(e)}`);
      });
  }, 50);

  function respond(result: string): void {
    const encoded = new TextEncoder().encode(result);
    // Never truncate a resource transaction into malformed JSON.
    const enc = encoded.length <= bytes.length ? encoded : new Uint8Array();
    if (encoded.length > bytes.length) onEvent("error", "Agent response exceeds bridge capacity");
    bytes.fill(0);
    bytes.set(enc);
    Atomics.store(i32, 1, enc.length);
    Atomics.store(i32, 0, BRIDGE_STATE_RESPONSE);
    Atomics.notify(i32, 0);
  }

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
    cancel(): void {
      const state = Atomics.load(i32, 0);
      if (state === BRIDGE_STATE_REQUEST || state === BRIDGE_STATE_CLAIMED) {
        Atomics.store(i32, 0, BRIDGE_STATE_CANCELLED);
        Atomics.notify(i32, 0);
      }
    },
    dispose(): void {
      clearInterval(timer);
      Atomics.store(i32, BRIDGE_PAUSE_SLOT, 0);
    },
  };
}
