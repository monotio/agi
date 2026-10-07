import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { StaticRoomScan } from "../../../src/agent/roomGraph.ts";

export interface RoomAnalysisInput {
  readonly logics: ReadonlyMap<number, Uint8Array>;
  readonly profile?: AgiProfile;
}
export type RoomAnalysisAnswer =
  | {
      readonly phase: "literal" | "resolved";
      readonly scans: Map<number, StaticRoomScan>;
      readonly shared: Set<number>;
      readonly elapsed?: number;
    }
  | { readonly phase: "failed"; readonly error: string };
export type RoomAnalysisStarter = (
  input: RoomAnalysisInput,
  answer: (result: RoomAnalysisAnswer) => void,
) => () => void;

/** Each revision owns one worker. Termination cancels even a busy fixpoint. */
export const startRoomAnalysis: RoomAnalysisStarter = (input, answer) => {
  const worker = new Worker(new URL("./roomAnalysis.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<RoomAnalysisAnswer>) => {
    if (event.data.phase !== "literal") worker.terminate();
    answer(event.data);
  };
  worker.onerror = () => {
    worker.terminate();
    answer({
      phase: "failed",
      error: "Room paths could not be read.",
    });
  };
  worker.postMessage(input);
  return () => worker.terminate();
};
