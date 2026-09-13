import {
  inspectGame,
  type PreviewWorkerInbound,
  type PreviewWorkerOutbound,
} from "./gameInspection.ts";

self.onmessage = (event: MessageEvent<PreviewWorkerInbound>) => {
  try {
    const result = inspectGame(event.data);
    self.postMessage({ result } satisfies PreviewWorkerOutbound, [result.rgba.buffer]);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    } satisfies PreviewWorkerOutbound);
  }
};
