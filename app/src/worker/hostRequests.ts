/**
 * The host-request suspension protocol: a request posts as an ordinary
 * worker message while the interpreter parks on the thrown HostWait; the
 * matching hostAnswer message delivers the response and resumes the pass.
 * Pure functions of the worker context — importable under Node.
 */
import { HostWait } from "../../../src/runtime/engine.ts";
import { prepareRoomPatch } from "../../../src/agent/roomPatch.ts";
import { buildWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import { base64ToBytes } from "../bytes.ts";
import type { HostRequestOp } from "../workerProtocol.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export function createHostRequests(ctx: WorkerContext) {
  /**
   * Post a host-service request as an ordinary worker message and suspend the
   * interpreter pass that asked for it. runLogicStack parks the logic stack on
   * the thrown HostWait; the { type: "hostAnswer" } reply delivers the response
   * and resumes the parked pass — so the host keeps inspecting, saving and
   * editing while the game waits.
   */
  function postHostRequest(op: HostRequestOp, context: Record<string, unknown>): never {
    if (ctx.recording.recording && !["getstring", "getnum"].includes(op))
      ctx.recording.recording.tainted = `The recording used unsupported host service ${op}.`;
    ctx.fns.advanceSoundClock();
    // The interpreter is about to suspend: ship the frame that shows the
    // prompt (or the selector) the request belongs to.
    ctx.fns.postFrame();
    const id = ++ctx.hostRequests.hostRequestSerial;
    const authoring = op === "room";
    ctx.hostRequests.hostRequestOutstanding = { id, op, authoring };
    ctx.ports.control({ type: "hostRequest", id, op, context });
    if (ctx.replay.replay && ["getnum", "getstring", "saveDescription"].includes(op)) {
      ctx.fns.postReplay(op);
    }
    if (authoring) ctx.ports.presentation({ type: "soundPaused", paused: true });
    throw new HostWait();
  }

  /** The request finished or was abandoned: release the authoring pause. */
  function settleHostRequest(outstanding: { op: string; authoring: boolean }): void {
    if (!outstanding.authoring) return;
    ctx.clocks.cycle.reset(
      ctx.replay.replay ? (ctx.replay.replay.tick * 1000) / 60 : ctx.ports.now(),
    );
    ctx.ports.presentation({ type: "soundPaused", paused: false });
  }

  /**
   * Drop the in-flight host request and tell the main thread to resolve the
   * UI it opened — a superseded request's late answer is dropped by the id
   * check in the hostAnswer handler.
   */
  function abandonHostRequest(): void {
    const outstanding = ctx.hostRequests.hostRequestOutstanding;
    if (outstanding === null) return;
    ctx.hostRequests.hostRequestOutstanding = null;
    settleHostRequest(outstanding);
    // An abandoned suspended re-enter can never land its transition.
    ctx.journal.pendingCause = null;
    ctx.ports.control({ type: "interactionCancelled", id: outstanding.id, op: outstanding.op });
  }

  /** Hand a host answer to the suspended interaction it resolves. */
  function deliverHostResponse(op: string, response: string): void {
    if (!ctx.engine) return;
    switch (op) {
      case "getnum": {
        const n = Number.parseInt(response, 10);
        const value = Number.isFinite(n) ? n : 0;
        if (ctx.recording.recording) {
          ctx.recording.recording.usedGetnum = true;
          ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "answer", text: response });
        }
        ctx.recording.recording?.tape.host(["number", value]);
        ctx.engine.deliverHostAnswer(value);
        return;
      }
      case "getstring": {
        if (ctx.recording.recording)
          ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "answer", text: response });
        ctx.recording.recording?.tape.host(["string", response]);
        ctx.engine.deliverHostAnswer(response);
        return;
      }
      case "saveList": {
        // Anything unparseable ("storage-error", an empty cancel) is a failed
        // listing; the selector shows its own failure screen for null.
        let slots: { slot: number; bytes: Uint8Array }[] | null;
        try {
          const parsed = JSON.parse(response) as { slot: number; image: string }[];
          slots = parsed.map(({ slot, image }) => ({ slot, bytes: base64ToBytes(image) }));
        } catch {
          slots = null;
        }
        ctx.engine.deliverHostAnswer(slots);
        return;
      }
      case "saveDescription": {
        // A cancelled prompt resolves ""; the empty answer cancels the dialog.
        let value: string | null;
        try {
          value = (JSON.parse(response) as { value: string | null }).value;
        } catch {
          value = null;
        }
        ctx.engine.deliverHostAnswer(value);
        return;
      }
      case "saveWrite":
        ctx.engine.deliverHostAnswer(response === "true");
        return;
      case "restore": {
        let bytes: Uint8Array | null = null;
        if (response) {
          try {
            bytes = base64ToBytes(response);
          } catch {
            bytes = null;
          }
        }
        if (bytes && ctx.recording.recording) {
          // A restore replaces the interpreter state mid-recording; the captured
          // steps no longer describe the live game.
          ctx.recording.recording.tainted = "the game was restored mid-recording";
        }
        if (bytes) ctx.fns.markRestore();
        ctx.engine.deliverHostAnswer(bytes);
        if (bytes) ctx.fns.noteTransition();
        return;
      }
      case "room": {
        // Apply the authored patch the agent produced, then deliver the outcome.
        const request = ctx.engine.hostInteraction;
        const room = request?.kind === "room" ? request.room : -1;
        let prepared = false;
        if (room >= 0) {
          try {
            const container = openContainer(ctx.engine.containerFiles);
            const patch = prepareRoomPatch(container, room, response, ctx.boot.liveDictionary);
            const words = buildWordsTok(patch.words.map(([word, id]) => ({ word, id })));
            for (const resource of patch.resources)
              ctx.engine.patchResource(resource.kind, resource.num, resource.payload);
            ctx.boot.liveDictionary.clear();
            for (const [word, id] of patch.words) ctx.boot.liveDictionary.set(word, id);
            ctx.boot.authoredWords = words;
            ctx.engine.patchAuxiliaryFiles({
              words,
              ...(patch.objects ? { objects: patch.objects } : {}),
              ...(patch.tests ? { tests: patch.tests } : {}),
            });
            prepared = true;
          } catch (error) {
            ctx.ports.presentation({
              type: "log",
              text: `Room ${room} authoring failed: ${String(error)}`,
            });
          }
        }
        ctx.engine.deliverHostAnswer(prepared);
        return;
      }
    }
  }

  function onHostAnswer(msg: Inbound<"hostAnswer">): void {
    // The main thread resolved the in-flight host request. A stale id —
    // an answer for a request already abandoned — is dropped, never
    // delivered.
    const id = Number(msg.id);
    const outstanding = ctx.hostRequests.hostRequestOutstanding;
    if (!ctx.engine || outstanding === null || outstanding.id !== id) return;
    ctx.hostRequests.hostRequestOutstanding = null;
    settleHostRequest(outstanding);
    try {
      deliverHostResponse(outstanding.op, String(msg.response ?? ""));
    } catch (wait) {
      if (!(wait instanceof HostWait)) throw wait;
    }
    // Apply the landed answer at this boundary rather than the next timer
    // pass: a message posted after the answer — a state query, the key's
    // own echo — observes the resumed state. A re-suspension (the
    // selector's next need) posts its request inside this tick.
    if (ctx.engine.hostInteractionReady) ctx.fns.tickEngine();
    // A transition resumed by this answer lands here, not in finishCycle.
    ctx.fns.noteTransition();
    // The runner holds the blocked observation postReplay(op) sent when
    // the request fired; the resumed state is its unblocked follow-up.
    if (ctx.replay.replay && !ctx.engine.awaitingHostAnswer) ctx.fns.postReplay(null, true);
  }

  function onReenter(msg: Inbound<"reenter">): void {
    if (!ctx.engine) return;
    if (ctx.recording.recording)
      ctx.recording.recording.tainted = "Game resources changed during recording.";
    // A suspended interaction is abandoned: its parked continuation is
    // meaningless once the room's resources change under it, and the
    // request still in flight resolves into a dropped answer.
    if (ctx.engine.hostInteractionPending) {
      ctx.engine.abortInteraction();
      ctx.fns.setKeyWaiting(false);
      abandonHostRequest();
    }
    // Live patch landed: re-enter the room so the new resources take effect.
    // An open message window blocks the cycle, and bytecode can never issue
    // new.room while one is up, so the harness acknowledges them first —
    // otherwise the re-entered room would sit behind an invisible window.
    for (let guard = 0; ctx.engine.modalKind !== null && guard < 16; guard++) ctx.engine.ackPrint();
    ctx.fns.markReenter();
    try {
      ctx.engine.reenterRoom(typeof msg.room === "number" ? msg.room : undefined);
    } catch (wait) {
      if (!(wait instanceof HostWait)) {
        // A declined re-enter never transitions; disarm so the next real
        // transition is not mislabeled.
        ctx.journal.pendingCause = null;
        throw wait;
      }
      // Room authoring suspended the transition: the hostAnswer message
      // delivers it and the timer's tick completes it, then reports.
      ctx.hostRequests.pendingReenter = true;
      ctx.fns.postFrame(true);
      return;
    }
    ctx.fns.noteTransition();
    ctx.fns.postFrame(true);
  }

  return {
    postHostRequest,
    settleHostRequest,
    abandonHostRequest,
    deliverHostResponse,
    onHostAnswer,
    onReenter,
  };
}

export type HostRequestsModule = ReturnType<typeof createHostRequests>;
