/**
 * Engine debug surface: debug channels, var/flag writes and reads, the trace
 * and event catch-up queries, and the frame-ring adapter the agent uses.
 * Thin wrappers over the worker link's query.
 */
import type { AgentFrame, FrameRequest } from "../../src/agent/frames.ts";
import type { RingFrame } from "./frameRing.ts";
import type { EngineState } from "./useEngineTypes.ts";
import type { WorkerLink } from "./useWorkerLink.ts";
import type { WorkerInbound } from "./workerProtocol.ts";

export function useEngineDebug(options: { state: EngineState; link: WorkerLink }) {
  const { state, link } = options;

  /**
   * Arm or disarm worker debug channels. ownership and objects ride on frame
   * posts; trace streams structured instruction records. Channels cost real
   * per-cycle work in the worker — arm only while an inspector view is open.
   */
  function setDebugChannels(
    channels: Partial<{ ownership: boolean; objects: boolean; trace: boolean; picture: boolean }>,
  ): void {
    Object.assign(state.debugChannels, channels);
    link.getWorker()?.postMessage({
      type: "debug",
      channels: { ...state.debugChannels },
    } satisfies WorkerInbound);
  }

  /**
   * Sierra's SET VAR / SET FLAG debug actions: [index, value] pairs applied at
   * the next cycle boundary and attributed to the current cycle in the diff
   * ring. Resolves when the worker acknowledges the write.
   */
  function debugWrite(
    vars: [number, number][] = [],
    flags: [number, number][] = [],
  ): Promise<Record<string, unknown>> {
    return link.query<Record<string, unknown>>("debugWrite", { vars, flags });
  }

  /** Var/flag diff events newer than `since` (a previous latestSeq). */
  function debugEventsSince(since: number): Promise<Record<string, unknown>> {
    return link.query<Record<string, unknown>>("debugEvents", { since });
  }

  /** Full scalar state snapshot (vars, flags, strings, objects' summary). */
  function readEngineState(): Promise<Record<string, unknown>> {
    return link.query<Record<string, unknown>>("state");
  }

  /** Trace ring records newer than `since` — the catch-up path for the live stream. */
  function debugTraceSince(since: number): Promise<Record<string, unknown>> {
    return link.query<Record<string, unknown>>("debugTrace", { since });
  }

  /** Live frames out of the worker ring, adapted to the agent's frame shape. */
  async function readFrames(req: FrameRequest): Promise<AgentFrame[]> {
    const frames = await link.query<RingFrame[]>("frames", {
      count: req.count,
      stride: req.stride,
    });
    return frames.map((f) => ({
      cycle: f.cycle,
      visual: new Uint8Array(f.visual),
      priority: new Uint8Array(f.priority),
      text: new Uint8Array(f.text),
      picRow: f.picRow,
    }));
  }

  return {
    setDebugChannels,
    debugWrite,
    debugEventsSince,
    debugTraceSince,
    readEngineState,
    readFrames,
  };
}

export type EngineDebug = ReturnType<typeof useEngineDebug>;
