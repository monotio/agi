/**
 * The world-map journal: one typed observation per room transition the live
 * interpreter performs. The engine reports new.room landings in place (edge
 * code still live, restart marked); restores, re-entries and debug jumps are
 * attributed by the worker boundary that caused them. Replay sessions are
 * scratch — nothing they observe reaches the journal. Pure functions of the
 * worker context — importable under Node.
 *
 * Recording and posting are separate: the listener records the observation
 * the moment the transition lands — score and carried items are read then,
 * before the new room's logic can change them — and the boundary flush stamps
 * the cycle the landing frame will carry. The frame and the entry then share
 * (session, patchGeneration, cycle), which is how the map binds a thumbnail
 * to the room the frame actually shows.
 */
import {
  EDGE_SIDES,
  type EdgeSide,
  type RoomTransitionCause,
} from "../../../src/agent/roomGraph.ts";
import type { WorkerContext } from "./context.ts";

const V_ROOM = 0;
const V_SCORE = 3;

export function createJournal(ctx: WorkerContext) {
  /**
   * Carried-inventory snapshot for delta computation: the item numbers the
   * player held at the previous entry (item room 255 means carried).
   */
  function carried(): number[] {
    return (ctx.run.engine?.readState().inventory ?? [])
      .filter((item) => item.room === 255)
      .map((item) => item.num)
      .sort((a, b) => a - b);
  }

  /** Record the fact at transition time; the boundary flush posts it. */
  function record(to: number, cause: RoomTransitionCause, edge?: EdgeSide): void {
    const j = ctx.run.journal;
    j.pending.push({
      from: j.lastRoom,
      to,
      cause,
      ...(edge !== undefined ? { edge } : {}),
      score: ctx.run.engine!.vars[V_SCORE]!,
      carried: carried(),
    });
    j.lastRoom = to;
  }

  /**
   * Post every recorded observation with its boundary identity. Called from
   * every boundary that can land or admit a transition — safe when nothing
   * was recorded.
   */
  function flush(): void {
    const j = ctx.run.journal;
    if (j.pending.length === 0) return;
    const patchGeneration = ctx.run.engine!.patchGeneration;
    for (const entry of j.pending) {
      const history = ctx.fns.historyMark(entry.to, entry.cause, entry.edge);
      ctx.ports.control({
        type: "roomTransition",
        seq: ++j.seq,
        from: entry.from,
        to: entry.to,
        cause: entry.cause,
        ...(entry.edge !== undefined ? { edge: entry.edge } : {}),
        cycle: ctx.run.cycle.cycleCount,
        patchGeneration,
        scoreDelta: entry.score - j.lastScore,
        gained: entry.carried.filter((num) => !j.lastCarried.includes(num)),
        lost: j.lastCarried.filter((num) => !entry.carried.includes(num)),
        ...(history !== null ? { history } : {}),
      });
      j.lastScore = entry.score;
      j.lastCarried = entry.carried;
    }
    j.pending = [];
    // Every room entry is a resume point: the map's journey and the history
    // anchors share the same recorded boundary.
    ctx.fns.historyAnchor("room");
  }

  /**
   * The engine's in-place transition report (a completed new.room). The
   * worker's pending cause wins — a re-enter still walks the engine's
   * transition path, but its honest cause is the authoring re-entry.
   */
  function onRoomTransition(_from: number, to: number, edge: number, restarted: boolean): void {
    const policy = ctx.run.rng.policy;
    if (policy.kind === "sequence" && policy.untilRoomChange)
      ctx.run.rng.policy = { kind: "external" };
    if (ctx.replay.replay) return; // scratch replay traffic stays out
    const j = ctx.run.journal;
    if (j.lastRoom === null) {
      const cause = j.pendingCause ?? "boot";
      j.pendingCause = null;
      record(to, cause);
      return;
    }
    const pending = j.pendingCause;
    j.pendingCause = null;
    if (pending !== null) {
      record(to, pending);
      return;
    }
    if (restarted) {
      ctx.fns.historyRecord({ kind: "restart" });
      record(to, "restart");
      return;
    }
    if (edge !== 0) {
      record(to, "edge", EDGE_SIDES[edge as keyof typeof EDGE_SIDES]);
      return;
    }
    record(to, "logic");
  }

  /**
   * Boundary flush: post what the boundary recorded, then check for drift —
   * a restore or a debug v0 write moves vars[0] without a new.room, and the
   * first call after boot records the session's starting room.
   */
  function noteTransition(): void {
    const engine = ctx.run.engine;
    if (!engine || ctx.replay.replay) {
      ctx.run.journal.pending = [];
      return;
    }
    const j = ctx.run.journal;
    const room = engine.vars[V_ROOM]!;
    if (j.lastRoom === null) {
      const cause = j.pendingCause ?? "boot";
      j.pendingCause = null;
      record(room, cause);
    } else if (room !== j.lastRoom || j.pendingCause !== null) {
      const pending = j.pendingCause;
      j.pendingCause = null;
      if (room === j.lastRoom) {
        // A same-room re-entry still earns an entry — a re-entered room is a
        // fresh visit, never a walkable exit.
        record(room, pending ?? "reenter");
      } else {
        // An unexplained v0 drift is jump-shaped: the observed room moved
        // without a transition the interpreter reported.
        record(room, pending ?? "jump");
      }
    }
    flush();
  }

  /** Arm the observation sink on the live engine; call after every boot. */
  function arm(): void {
    ctx.run.engine?.setRoomTransitionListener(onRoomTransition);
  }

  /**
   * Re-baseline after replay exit: the scratch session may have moved the
   * room; the live journal continues from wherever the engine actually is
   * without inventing a transition.
   */
  function rebaseline(): void {
    const j = ctx.run.journal;
    j.pending = [];
    j.pendingCause = null;
    j.lastRoom = ctx.run.engine ? ctx.run.engine.vars[V_ROOM]! : null;
    if (ctx.run.engine) {
      j.lastScore = ctx.run.engine.vars[V_SCORE]!;
      j.lastCarried = carried();
    }
  }

  /** The authoring re-enter message sets the pending cause; the listener emits. */
  function markReenter(): void {
    ctx.run.journal.pendingCause = "reenter";
  }

  /** A save image was delivered to the suspended restore interaction. */
  function markRestore(): void {
    ctx.run.journal.pendingCause = "restore";
  }

  /** A debug write touched v0 — the next observed room is a jump. */
  function markJump(): void {
    ctx.run.journal.pendingCause = "jump";
  }

  return {
    armJournal: arm,
    noteTransition,
    rebaselineJournal: rebaseline,
    markReenter,
    markRestore,
    markJump,
  };
}
