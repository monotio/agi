import { scanContainerExits } from "../../../src/agent/roomMap.ts";
import type { RoomAnalysisAnswer, RoomAnalysisInput } from "./roomAnalysisRunner.ts";

self.onmessage = (event: MessageEvent<RoomAnalysisInput>) => {
  const { logics, profile } = event.data;
  const start = performance.now();
  try {
    self.postMessage({
      phase: "literal",
      ...scanContainerExits(logics, profile, { literal: true }),
      elapsed: performance.now() - start,
    } satisfies RoomAnalysisAnswer);
    self.postMessage({
      phase: "resolved",
      ...scanContainerExits(logics, profile, { main: true }),
      elapsed: performance.now() - start,
    } satisfies RoomAnalysisAnswer);
  } catch (error) {
    self.postMessage({
      phase: "failed",
      error: error instanceof Error ? error.message : String(error),
    } satisfies RoomAnalysisAnswer);
  }
};
