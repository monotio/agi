/**
 * Room Studio's test walk off the main thread: `testRoute`
 * (src/studio/route.ts) boots a throwaway copy of the game and walks ego
 * through it, which takes too long to run while the canvas waits. A fresh
 * worker (route.worker.ts) runs each walk and is terminated after it; a
 * walk that never answers fails after a deadline instead of hanging.
 */
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { RoutePoint, RouteTestResult } from "../../../src/studio/route.ts";

/** What the route worker runs: testRoute's input with plain, cloneable files. */
export interface RouteWorkerInbound {
  readonly files: Record<string, Uint8Array>;
  readonly profile: ProfileId;
  readonly room: number;
  readonly from: RoutePoint;
  readonly to: RoutePoint;
  readonly via?: readonly RoutePoint[];
  /** The live game's state, written before the room is entered (testRoute's preset). */
  readonly flags?: readonly { id: number; value: boolean }[];
  readonly vars?: readonly { id: number; value: number }[];
  readonly maxCycles?: number;
}

export type RouteWorkerOutbound = { result: RouteTestResult } | { error: string };

/** Runs one test walk; the Walk view injects its own in tests. */
export type RouteRunner = (input: RouteWorkerInbound) => Promise<RouteTestResult>;

/** A walk that takes longer than this has failed. */
const ROUTE_TIMEOUT_MS = 30_000;

export const runRouteInWorker: RouteRunner = (input) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../route.worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("The test walk took too long and was stopped."));
    }, ROUTE_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<RouteWorkerOutbound>) => {
      finish();
      if ("result" in event.data) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("The test walk could not start."));
    };
    worker.postMessage(input satisfies RouteWorkerInbound);
  });
