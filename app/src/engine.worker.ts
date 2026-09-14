/// <reference types="vite/client" />
/**
 * Engine worker: hosts the authentic interpreter off the main thread.
 * Message shapes are defined once in workerProtocol.ts — WorkerInbound in,
 * WorkerControl and WorkerPresentation out — and both dispatchers typecheck
 * against them. The message dispatch lives in worker/dispatch.ts so Node
 * tests can drive the real handlers with a fake-port context.
 */
import { createEngineHost } from "./worker/host.ts";
import { createWorkerContext, type WorkerPorts } from "./worker/context.ts";
import { onWorkerMessage } from "./worker/dispatch.ts";
import type { WorkerControl, WorkerInbound, WorkerPresentation } from "./workerProtocol.ts";

const ports: WorkerPorts = {
  control: (message, options) => sendControl(message, options),
  presentation: (message, options) => sendPresentation(message, options),
  now: () => performance.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancelSchedule: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** All mutable worker state lives on the context; see worker/context.ts. */
const ctx = createWorkerContext(ports);

function sendControl(message: WorkerControl, options?: Transferable[]): void {
  if (ctx.replay.currentSessionId > 0 && !("sessionId" in message)) {
    (message as Record<string, unknown>)["sessionId"] = ctx.replay.currentSessionId;
  }
  self.postMessage(message, options ?? []);
}

function sendPresentation(message: WorkerPresentation, options?: Transferable[]): void {
  if (ctx.replay.currentSessionId > 0 && !("sessionId" in message)) {
    (message as Record<string, unknown>)["sessionId"] = ctx.replay.currentSessionId;
  }
  self.postMessage(message, options ?? []);
}

ctx.host = createEngineHost(ctx);

self.onmessage = (ev: MessageEvent) => onWorkerMessage(ctx, ev.data as WorkerInbound);
