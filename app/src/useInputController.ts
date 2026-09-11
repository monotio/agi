import type { Bridge } from "./agent/sabBridge.ts";

export type LogAgentFn = (
  kind: "request" | "response" | "error" | "log" | "input",
  detail: string,
  data?: unknown,
) => void;

export interface InputControllerOptions {
  readonly getWorker: () => Worker | null;
  readonly getBridge: () => Bridge | null;
  readonly isSeeking: () => boolean;
  readonly isHoldToMove: () => boolean;
  readonly setWaitingForKey: (waiting: boolean) => void;
  readonly logAgent: LogAgentFn;
  readonly getActiveWalkthroughSession: () => number;
}

export interface InputController {
  sendInput(text: string): void;
  sendEdit(text: string): void;
  sendDirection(dir: number, sessionId?: number): void;
  sendKey(code: number, sessionId?: number): void;
  handleWaitKey(): string | Promise<string>;
  acknowledgeKey(id: number): void;
  resetKeys(): void;
}

/** Composable managing engine input text, direction, key queuing, and bridge waitkey synchronization. */
export function useInputController(options: InputControllerOptions): InputController {
  let keyWaitResolver: ((value: string) => void) | null = null;
  const pendingKeys = new Map<number, number>();
  let nextKeyId = 0;

  function sendInput(text: string): void {
    if (!options.isSeeking()) {
      options.logAgent("input", text);
    }
    options.getWorker()?.postMessage({ type: "input", text });
  }

  /** Mirror the host input widget's live text onto the engine's input row. */
  function sendEdit(text: string): void {
    options.getWorker()?.postMessage({ type: "edit", text });
  }

  function sendDirection(dir: number, sessionId?: number): void {
    const activeSession = options.getActiveWalkthroughSession();
    const session = sessionId ?? (activeSession > 0 ? activeSession : 0);
    options.getWorker()?.postMessage({
      type: "direction",
      dir,
      releaseEligible: options.isHoldToMove(),
      ...(session > 0 ? { sessionId: session } : {}),
    });
  }

  function sendKey(code: number, sessionId?: number): void {
    const worker = options.getWorker();
    if (!worker) return;
    options.getBridge()?.pollNow();
    const id = ++nextKeyId;
    pendingKeys.set(id, code);
    const activeSession = options.getActiveWalkthroughSession();
    const session = sessionId ?? (activeSession > 0 ? activeSession : 0);
    const keyMsg = {
      type: "key",
      id,
      code,
      ...(session > 0 ? { sessionId: session } : {}),
    };
    if (keyWaitResolver) {
      const resolve = keyWaitResolver;
      keyWaitResolver = null;
      options.setWaitingForKey(false);
      const queued = pendingKeys.entries().next().value!;
      pendingKeys.delete(queued[0]);
      resolve(JSON.stringify({ id: queued[0], code: queued[1] }));
      // If the worker resumes normal execution instead of waiting again, it
      // still receives this key. The sequence ID suppresses bridge duplicates.
      worker.postMessage(keyMsg);
      return;
    }
    worker.postMessage(keyMsg);
  }

  function handleWaitKey(): string | Promise<string> {
    const queued = pendingKeys.entries().next().value;
    if (queued) {
      pendingKeys.delete(queued[0]);
      return JSON.stringify({ id: queued[0], code: queued[1] });
    }
    options.setWaitingForKey(true);
    return new Promise<string>((resolve) => {
      keyWaitResolver = resolve;
    });
  }

  function acknowledgeKey(id: number): void {
    pendingKeys.delete(id);
  }

  function resetKeys(): void {
    pendingKeys.clear();
    if (keyWaitResolver) {
      keyWaitResolver("0");
      keyWaitResolver = null;
      options.setWaitingForKey(false);
    }
  }

  return {
    sendInput,
    sendEdit,
    sendDirection,
    sendKey,
    handleWaitKey,
    acknowledgeKey,
    resetKeys,
  };
}
