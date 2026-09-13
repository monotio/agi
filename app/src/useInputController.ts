import type { WorkerInbound } from "./workerProtocol.ts";

export type LogAgentFn = (
  kind: "request" | "response" | "error" | "log" | "telemetry" | "input",
  detail: string,
  data?: unknown,
) => void;

export interface InputControllerOptions {
  readonly getWorker: () => Worker | null;
  readonly isSeeking: () => boolean;
  readonly isHoldToMove: () => boolean;
  readonly logAgent: LogAgentFn;
  readonly getActiveWalkthroughSession: () => number;
}

export interface InputController {
  sendInput(text: string): void;
  sendEdit(text: string): void;
  sendDirection(dir: number, sessionId?: number): void;
  sendKey(code: number, sessionId?: number): void;
}

/** Composable managing engine input text, direction, and key queuing. */
export function useInputController(options: InputControllerOptions): InputController {
  function sendInput(text: string): void {
    if (!options.isSeeking()) {
      options.logAgent("input", text);
    }
    options.getWorker()?.postMessage({ type: "input", text } satisfies WorkerInbound);
  }

  /** Mirror the host input widget's live text onto the engine's input row. */
  function sendEdit(text: string): void {
    options.getWorker()?.postMessage({ type: "edit", text } satisfies WorkerInbound);
  }

  function sendDirection(dir: number, sessionId?: number): void {
    const activeSession = options.getActiveWalkthroughSession();
    const session = sessionId ?? (activeSession > 0 ? activeSession : 0);
    options.getWorker()?.postMessage({
      type: "direction",
      dir,
      releaseEligible: options.isHoldToMove(),
      ...(session > 0 ? { sessionId: session } : {}),
    } satisfies WorkerInbound);
  }

  function sendKey(code: number, sessionId?: number): void {
    const worker = options.getWorker();
    if (!worker) return;
    const activeSession = options.getActiveWalkthroughSession();
    const session = sessionId ?? (activeSession > 0 ? activeSession : 0);
    worker.postMessage({
      type: "key",
      code,
      ...(session > 0 ? { sessionId: session } : {}),
    } satisfies WorkerInbound);
  }

  return {
    sendInput,
    sendEdit,
    sendDirection,
    sendKey,
  };
}
