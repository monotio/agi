/**
 * Room visits, Launches and returns share run validation and adoption.
 * Coordinate placement re-enters through the engine's room continuation,
 * then starts a history segment from the resulting resumable boundary.
 */

import { openContainer } from "../../../src/container/container.ts";
import { placeEgo, playHereProblem } from "../../../src/runtime/playHere.ts";
import type { Inbound, WorkerContext } from "./context.ts";
import { adoptResumePoint, enterCreateRun } from "./resumePoint.ts";
import { launchRoom } from "./roomLaunch.ts";

export function createPlayHere(ctx: WorkerContext) {
  function onPlayHere(msg: Inbound<"playHere">): void {
    const reply = (ok: boolean, reason?: string): void => {
      const engine = ctx.run.engine;
      const ego = engine?.screenObjects[0];
      ctx.ports.control({
        type: "playedHere",
        id: msg.id,
        ok,
        room: engine?.vars[0] ?? 0,
        x: ego?.x ?? 0,
        y: ego?.y ?? 0,
        ...(reason === undefined ? {} : { reason }),
        ...(ctx.run.progress.mode === "create" && (msg.visit || msg.launch)
          ? { returnRoom: ctx.run.progress.room }
          : {}),
      });
    };
    const engine = ctx.run.engine;
    if (!ctx.run.owner.active) return reply(false, "Take back to play this game.");
    if (!engine || ctx.replay.replay || ctx.view.drive)
      return reply(false, "Play here needs the live game. Leave the replay or history view first.");
    const progress = ctx.run.progress;
    if (msg.visit === "back" || msg.launch?.fromMyGame) {
      if (progress.mode !== "create") return reply(false, "Open Create to return to your game.");
      try {
        adoptResumePoint(ctx, progress.returnPoint, {
          currentFiles: true,
          paused: progress.returnPoint.clock?.paused ?? false,
          cycle: progress.cycle,
          tick: progress.tick,
          ...(msg.launch?.debug ? { debug: true } : {}),
        });
        return reply(true);
      } catch (cause) {
        return reply(
          false,
          `${cause instanceof Error ? cause.message : String(cause)} Choose Restart to play from the beginning.`,
        );
      }
    }
    if (msg.launch) {
      const problem = launchRoom(ctx, msg);
      return reply(problem === null, problem ?? undefined);
    }
    const problem = playHereProblem(msg);
    if (problem !== null) return reply(false, problem);
    if (engine.textModeActive) return reply(false, "The game is showing its text screen.");
    const files = openContainer(engine.containerFiles, { profile: engine.profile });
    if (!files.getResource("logic", msg.room))
      return reply(false, `Room ${msg.room} has no logic to enter.`);
    if (msg.visit === "start" && engine.vars[0] === msg.room) return reply(true);
    if (msg.visit) {
      try {
        enterCreateRun(ctx);
        const point = ctx.run.progress;
        if (point.mode === "create")
          adoptResumePoint(ctx, point.returnPoint, {
            currentFiles: true,
            paused: ctx.run.cycle.paused,
            cycle: point.cycle,
            tick: point.tick,
          });
        const problem = launchRoom(ctx, { ...msg, launch: {} });
        if (problem === null && ctx.run.engine!.vars[0] !== msg.room)
          return reply(false, `Room ${msg.room} moved to room ${ctx.run.engine!.vars[0]}.`);
        return reply(problem === null, problem ?? undefined);
      } catch (cause) {
        return reply(false, cause instanceof Error ? cause.message : String(cause));
      }
    }

    // The first request may have awaited a module import. Release the current
    // debugger latch only now, when the validated jump actually runs.
    ctx.fns.debugBeforeReplace();
    if (ctx.run.recording.recording)
      ctx.run.recording.recording.tainted = "Play here moved the game.";
    if (engine.hostInteractionPending) {
      engine.abortInteraction();
      ctx.fns.setKeyWaiting(false);
      ctx.fns.abandonHostRequest();
    }
    for (
      let guard = 0;
      engine.modalKind !== null && engine.modalKind !== "print" && guard < 16;
      guard++
    )
      engine.ackPrint();
    ctx.fns.historyEnd("walkthrough");
    ctx.run.input.deferredMovement.length = 0;
    ctx.fns.markJump();
    // Clear the edge so the transition does not snap ego to a border first.
    engine.vars[2] = 0;
    // The room's logic exists, so an authored game's prepareRoom answers at once.
    const authorRooms = ctx.boot.authorRooms;
    if (msg.visit) ctx.boot.authorRooms = false;
    // The room's own entry pass: load, draw and position what it owns.
    // Armed execution control counts a completed entry pass inside
    // tickEngine and a stopped or suspended one nowhere — the explicit
    // finish belongs to the ordinary unarmed pass only.
    try {
      engine.reenterRoom(msg.room);
      ctx.fns.setKeyWaiting(false);
      ctx.fns.abandonHostRequest();
      ctx.fns.debugSessionReplaced();
      ctx.fns.tickEngine();
    } catch (cause) {
      if (!msg.visit) throw cause;
      return reply(
        false,
        `Room ${msg.room} could not finish its entry. View its picture while paused.`,
      );
    } finally {
      ctx.boot.authorRooms = authorRooms;
    }
    if (engine.executionStopInfo !== null || engine.executionYieldPending)
      return reply(
        false,
        `Room ${msg.room} entry did not complete. Continue the game to finish setup.`,
      );
    if (!engine.executionControlActive) ctx.fns.finishCycle();
    const verdict = msg.visit
      ? engine.hostInteractionPending || engine.vars[0] !== msg.room
        ? "busy"
        : "ok"
      : engine.hostInteractionPending
        ? "busy"
        : placeEgo(engine, msg.x, msg.y);
    ctx.fns.captureStateDiffs();
    ctx.fns.historyResume();
    ctx.run.presentation.lastVisual = null;
    ctx.fns.postFrame(true);
    if (verdict === "ok") return reply(true);
    reply(
      false,
      verdict === "busy"
        ? `Room ${msg.room} is waiting for the host; ego stays where the room put it.`
        : verdict === "no-ego"
          ? `Room ${msg.room} has no ego on screen to place.`
          : `Ego cannot stand at (${msg.x},${msg.y}) in room ${msg.room}: ${verdict}. It stays where the room put it.`,
    );
  }

  return { onPlayHere };
}
