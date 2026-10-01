/** Lightweight MAIN transport; debugger plans and presentation load on first use. */
import { shallowRef } from "vue";
import type { WorkerControl, WorkerQueryFn } from "../worker/workerProtocol.ts";
export type ExecutionDebugEvent = Extract<
  WorkerControl,
  {
    type: "debugStopped" | "debugDetached" | "debugSessionReset" | "debugAnswerReady" | "debugLog";
  }
>;
export function createExecutionDebugLink(send: WorkerQueryFn) {
  const stopped = shallowRef<Extract<WorkerControl, { type: "debugStopped" }> | null>(null);
  const listeners = new Set<(event: ExecutionDebugEvent) => void>();
  const waiters = new Set<() => void>();
  let held = false;
  function release(): void {
    held = false;
    for (const wake of waiters) wake();
    waiters.clear();
  }
  function reset(): void {
    stopped.value = null;
    release();
  }
  function handle(event: ExecutionDebugEvent): void {
    if (event.type === "debugStopped") {
      stopped.value = event;
      held = true;
    } else if (event.type === "debugDetached" || event.type === "debugSessionReset") reset();
    for (const listener of listeners) listener(event);
  }
  const query: WorkerQueryFn = async (type, extra, timeout) => {
    const previous = stopped.value;
    if (type === "debugResume") stopped.value = null;
    try {
      const reply = await send(type, extra, timeout);
      if (
        type === "debugDetach" ||
        (type === "debugResume" && extra?.["action"] === "continue" && stopped.value === null)
      )
        release();
      return reply;
    } catch (error) {
      if (type === "debugResume" && stopped.value === null) stopped.value = previous;
      throw error;
    }
  };
  async function waitUntilContinued(): Promise<void> {
    while (held) await new Promise<void>((resolve) => waiters.add(resolve));
  }
  return {
    stopped,
    query,
    handle,
    reset,
    waitForContinue(): Promise<void> | undefined {
      if (held) return waitUntilContinued();
      return undefined;
    },
    subscribe(listener: (event: ExecutionDebugEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
