import { inspectGame } from "./gameInspection.ts";

self.onmessage = (
  event: MessageEvent<{ files: Record<string, Uint8Array>; words: [string, number][] }>,
) => {
  try {
    const result = inspectGame(event.data);
    self.postMessage({ result }, [result.rgba.buffer]);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
