/**
 * Player-input intake: queued keys, deferred walking movement, the parser
 * line buffer and the suspended key wait. Pure functions of the worker
 * context — importable under Node for unit tests.
 */
import { AGI_KEY, DIRECTION_KEYS, NAV_KEYS } from "../../../src/runtime/keys.ts";
import type { Inbound, WorkerContext } from "./context.ts";

export function createInput(ctx: WorkerContext) {
  function setKeyWaiting(waiting: boolean): void {
    if (waiting === ctx.input.keyWaiting) return;
    ctx.input.keyWaiting = waiting;
    ctx.ports.presentation({ type: "waitingForKey", waiting });
  }

  function flushDeferredMovement(): void {
    if (!ctx.engine || ctx.engine.modalKind !== null || ctx.engine.continuationPending) return;
    for (const key of ctx.input.deferredMovement.splice(0)) {
      if (key === 0) {
        if (ctx.recording.recording)
          ctx.recording.recording.tape.run("release", () => ctx.engine!.releaseTrackedKey(true));
        else ctx.engine.releaseTrackedKey(true);
      } else ctx.input.keyQueue.push(key);
    }
    // Keys flushed while an interaction is parked still feed its key wait.
    deliverQueuedKey();
  }

  /**
   * A queued key answers a parked key wait: no host request was ever posted
   * for it, so the arriving key is its answer — applied at this message
   * boundary exactly like a host answer. Replay mode has no timer to pick it
   * up later.
   */
  function deliverQueuedKey(): void {
    if (!ctx.engine?.awaitingKey) return;
    const queued = ctx.input.keyQueue.shift();
    if (queued === undefined) return;
    setKeyWaiting(false);
    if (ctx.recording.recording) {
      // The answer and the resumed pass belong to one recorded operation —
      // the same shape a live suspension produces. Recording the delivery
      // inside the tick run keeps it in the list: outside a run, tape.host
      // drops calls, and a recording that started on this wait would lose it.
      ctx.recording.recording.tape.run("tick", () => {
        ctx.recording.recording!.tape.host(["waitKey", queued]);
        ctx.engine!.deliverHostAnswer(queued);
        ctx.engine!.tick();
      });
      if (ctx.engine.awaitingHostAnswer) ctx.recording.recording.tape.holdTick();
    } else {
      ctx.engine.deliverHostAnswer(queued);
      if (ctx.engine.hostInteractionReady) ctx.fns.tickEngine();
    }
    if (ctx.replay.replay && !ctx.engine.awaitingHostAnswer) ctx.fns.postReplay(null, true);
  }

  function onKey(msg: Inbound<"key">): void {
    if (
      ctx.replay.replay &&
      typeof msg.sessionId === "number" &&
      msg.sessionId !== 0 &&
      msg.sessionId !== ctx.replay.currentSessionId
    ) {
      return;
    }
    flushDeferredMovement();
    const key = Number(msg.code) & 0xffff;
    ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "key", code: key });
    // A parked key wait answers from the queue directly — any key,
    // including a navigation key that would otherwise defer.
    const keyWaitParked = ctx.engine?.awaitingKey === true;
    if (
      !keyWaitParked &&
      ctx.input.deferredMovement.length > 0 &&
      ctx.engine?.modalKind === null &&
      NAV_KEYS[key] !== undefined
    ) {
      if (ctx.input.deferredMovement.length < 19) ctx.input.deferredMovement.push(key);
    } else ctx.input.keyQueue.push(key);
    deliverQueuedKey();
  }

  function onDirection(msg: Inbound<"direction">): void {
    if (!ctx.engine) return;
    if (
      ctx.replay.replay &&
      typeof msg.sessionId === "number" &&
      msg.sessionId !== 0 &&
      msg.sessionId !== ctx.replay.currentSessionId
    ) {
      return;
    }
    const dir = Number(msg.dir) & 0xff;
    if (dir === 0) {
      // The main thread captures the gate even while save/restore blocks us.
      // In replay the tape's ordering is exact, so the engine's own gate is
      // truth; the mirrored holdToMove goes stale while frames are
      // suppressed during seeking.
      const eligible = ctx.replay.replay
        ? ctx.engine.releaseGate !== 0
        : typeof msg.releaseEligible === "boolean"
          ? msg.releaseEligible
          : ctx.engine.releaseGate !== 0;
      if (eligible && ctx.input.deferredMovement.length < 19) ctx.input.deferredMovement.push(0);
      if (eligible) ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "release" });
      flushDeferredMovement();
      return;
    }
    const dirKey = DIRECTION_KEYS[dir];
    if (ctx.engine.modalKind !== null) {
      // Arrows steer the open modal (inventory selection, menu) instead of
      // ego; the direction key word replays the same navigation.
      if (dirKey !== undefined)
        ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "key", code: dirKey });
      ctx.recording.recording?.tape.record(["navigate", dir]);
      ctx.engine.modalNavigate(dir);
      ctx.fns.postFrame();
      return;
    }
    flushDeferredMovement();
    if (dirKey !== undefined) {
      // Hold-to-move games keep the heading until the release; tap games
      // toggle it with the key word itself, exactly as the runner replays.
      if (ctx.engine.releaseGate !== 0)
        ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "direction", dir });
      else ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "key", code: dirKey });
      if (ctx.input.deferredMovement.length > 0 && !ctx.engine.awaitingKey) {
        if (ctx.input.deferredMovement.length < 19) ctx.input.deferredMovement.push(dirKey);
      } else ctx.input.keyQueue.push(dirKey);
      deliverQueuedKey();
    }
  }

  function onInput(msg: Inbound<"input">): void {
    const text = String(msg.text);
    ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "command", text });
    ctx.input.inputBuffer.push(text);
  }

  function onEdit(msg: Inbound<"edit">): void {
    if (!ctx.engine) return;
    // Live mirror of the host's input widget onto the engine's input row.
    ctx.recording.recording?.tape.record(["edit", String(msg.text)]);
    ctx.engine.setEditLine(String(msg.text));
    // Host typing is already in the input widget. Publish only edits made by game logic.
    ctx.presentation.lastInputEdit = ctx.engine.inputEdit;
    ctx.fns.postFrame();
  }

  function onDismissPrint(): void {
    if (!ctx.engine) return;
    ctx.recording.recording?.tape.record(["ack"]);
    ctx.fns.recordEvent({ cycle: ctx.cycle.cycleCount, kind: "key", code: AGI_KEY.ENTER });
    const pending = ctx.engine.hostInteraction;
    // A click on the suspended selector or confirmation answers with its
    // cancel key; a request still in flight resolves into a dropped answer.
    if (pending !== null && ctx.engine.awaitingHostAnswer) {
      if (pending.kind === "saveDialog" || pending.kind === "confirm") {
        setKeyWaiting(false);
        ctx.fns.abandonHostRequest();
        ctx.engine.deliverHostAnswer(AGI_KEY.ESCAPE);
      }
    }
    ctx.engine.ackPrint();
    ctx.fns.postFrame();
  }

  return {
    setKeyWaiting,
    flushDeferredMovement,
    deliverQueuedKey,
    onKey,
    onDirection,
    onInput,
    onEdit,
    onDismissPrint,
  };
}

export type InputModule = ReturnType<typeof createInput>;
