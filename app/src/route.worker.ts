import { testRoute } from "../../src/studio/route.ts";
import type { RouteWorkerInbound, RouteWorkerOutbound } from "./studio/routeRunner.ts";

/** One Room Studio test walk in a throwaway engine; the caller terminates the worker after it. */
self.onmessage = (event: MessageEvent<RouteWorkerInbound>) => {
  const { files, ...walk } = event.data;
  try {
    const result = testRoute({ ...walk, game: new Map(Object.entries(files)) });
    self.postMessage({ result } satisfies RouteWorkerOutbound);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    } satisfies RouteWorkerOutbound);
  }
};
