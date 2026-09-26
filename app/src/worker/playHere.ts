/**
 * Play here: the live game jumps to a room and spot, keeping the session's
 * flags, variables and inventory. The worker runs it between polls as
 * ordinary host actions: abandon a parked interaction, acknowledge open
 * windows, re-enter the room as new.room would, run the room's entry cycle
 * so its own logic sets the room up, then place ego
 * (src/studio/playHere.ts).
 *
 * The history tape records host causes, and a jump of ego is not one it
 * can replay. So the open segment ends first with the existing "walkthrough"
 * end — a host takeover of the live state, as a walkthrough's is — and the
 * next resumable boundary begins a new segment from a full snapshot of the
 * placed state. No event, field or format changes; saves are untouched.
 */

import { openContainer } from "../../../src/container/container.ts";
import { placeEgo, playHereProblem } from "../../../src/studio/playHere.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export function createPlayHere(ctx: WorkerContext) {
  function onPlayHere(msg: Inbound<"playHere">): void {
    const reply = (ok: boolean, reason?: string): void => {
      const engine = ctx.engine;
      const ego = engine?.screenObjects[0];
      ctx.ports.control({
        type: "playedHere",
        id: msg.id,
        ok,
        room: engine?.vars[0] ?? 0,
        x: ego?.x ?? 0,
        y: ego?.y ?? 0,
        ...(reason === undefined ? {} : { reason }),
      });
    };
    const engine = ctx.engine;
    if (!engine || ctx.replay.replay || ctx.view.drive)
      return reply(false, "Play here needs a live game, not a replay or history view.");
    const problem = playHereProblem(msg);
    if (problem !== null) return reply(false, problem);
    if (engine.textModeActive) return reply(false, "The game is showing its text screen.");
    const files = openContainer(engine.containerFiles);
    if (!files.getResource("logic", msg.room))
      return reply(false, `Room ${msg.room} has no logic to enter.`);

    if (ctx.recording.recording) ctx.recording.recording.tainted = "Play here moved the game.";
    if (engine.hostInteractionPending) {
      engine.abortInteraction();
      ctx.fns.setKeyWaiting(false);
      ctx.fns.abandonHostRequest();
    }
    for (let guard = 0; engine.modalKind !== null && guard < 16; guard++) engine.ackPrint();
    ctx.fns.historyEnd("walkthrough");
    ctx.input.deferredMovement.length = 0;
    ctx.fns.markJump();
    // Clear the edge so the transition does not snap ego to a border first.
    engine.vars[2] = 0;
    // The room's logic exists, so an authored game's prepareRoom answers at once.
    engine.reenterRoom(msg.room);
    // The room's own entry pass: load, draw and position what it owns.
    ctx.fns.tickEngine();
    ctx.fns.finishCycle();
    const verdict = engine.hostInteractionPending ? "busy" : placeEgo(engine, msg.x, msg.y);
    ctx.fns.captureStateDiffs();
    ctx.fns.historyResume();
    ctx.presentation.lastVisual = null;
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

export type PlayHereModule = ReturnType<typeof createPlayHere>;
