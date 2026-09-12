/**
 * Evaluates walkthrough actions against the live engine. Inputs go straight to
 * the worker through the driver — the same functions App.vue's keyboard
 * handlers call — so replay never impersonates DOM events and cannot leak
 * synthetic key state across sessions. Time advances as recorded virtual
 * ticks; the runner only paces, pauses and observes.
 */
import { DIRECTION_KEYS } from "../../src/agent/gameTestSteps.ts";
import type {
  ReplayAction,
  ReplayBatchOptions,
  ReplayBatchResult,
  ReplayDriver,
  ReplayObservation,
} from "./replay.ts";
import type { Frame } from "./gameTypes.ts";

/** Deterministic FNV-1a hash of the composited frame for regression checks. */
export async function computeScreenHash(frame: Frame | null): Promise<string> {
  if (frame) {
    const data = new Uint8Array(frame.visual.length + frame.text.length);
    data.set(frame.visual);
    data.set(frame.text, frame.visual.length);

    let hash = 0x811c9dc5;
    for (const byte of data) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  return "no-frame";
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Detects whether the engine is currently displaying a story dialogue modal
 * (such as a print window or showObj description) or a full-screen waitkey screen.
 */
export function isStoryDialogue(obs: ReplayObservation | null): boolean {
  if (!obs) return false;
  return (
    obs.state.modalKind === "print" ||
    obs.state.modalKind === "showObj" ||
    obs.blocked === "waitkey"
  );
}

/**
 * Identity of the dialogue an observation shows. A modal window gets a fresh
 * serial every time the interpreter pushes it, so two back-to-back print
 * windows are two beats even when no observation ever reports modal=null
 * between them; a waitkey block is one posted observation per episode, so its
 * revision is already unique.
 */
export function storyDialogueKey(obs: ReplayObservation | null): string | null {
  if (!obs) return null;
  if (obs.state.modalKind === "print" || obs.state.modalKind === "showObj")
    return `modal:${obs.state.modalSerial}`;
  if (obs.blocked === "waitkey") return `waitkey:${obs.revision}`;
  return null;
}

export async function runReplayBatch(
  driver: ReplayDriver,
  actions: readonly ReplayAction[],
  options?: ReplayBatchOptions & { getLatestFrame?: () => Frame | null },
): Promise<ReplayBatchResult> {
  const rawSpeed = options?.speed;
  const getSpeed: () => number = typeof rawSpeed === "function" ? rawSpeed : () => rawSpeed ?? 0;
  const currentSessionId = options?.sessionId ?? driver.sessionId ?? 0;
  let currentRequestId = 0;
  // Story pause fires once per dialogue beat: the serial of the beat already
  // paused on, and the beat whose tail is being fast-forwarded after resume.
  let pausedDialogueKey: string | null = null;
  let skipDialogueTail: string | null = null;

  function updateStatus(status: string, requestId = currentRequestId): void {
    driver.status = {
      sessionId: currentSessionId,
      requestId,
      observedTick: driver.latest?.tick ?? 0,
      revision: driver.latest?.revision ?? 0,
      status,
    };
  }

  updateStatus("running");

  function isRunActive(): boolean {
    if (options?.signal?.aborted) return false;
    if (options?.isCurrentSession && !options.isCurrentSession()) return false;
    return true;
  }

  function checkAborted(): void {
    if (options?.signal?.aborted) {
      throw new DOMException("Replay aborted", "AbortError");
    }
    if (options?.isCurrentSession && !options.isCurrentSession()) {
      throw new DOMException("Replay superseded by new session", "AbortError");
    }
  }

  function isSeeking(): boolean {
    const target = options?.getSeekTarget?.();
    if (target === null || target === undefined) return false;
    const current = driver.latest?.tick ?? 0;
    if (current >= target) {
      options?.onSeekComplete?.();
      return false;
    }
    return true;
  }

  /** Fast-forward rate for the dwell between a dialogue pause and its ack. */
  const DIALOGUE_SKIP_SPEED = 600;

  function getEffectiveSpeed(): number {
    if (isSeeking()) return 0;
    // Resuming from a dialogue pause fast-forwards the tape's remaining dwell
    // until that modal closes, so "continue" actually dismisses the window.
    if (
      skipDialogueTail !== null &&
      driver.latest &&
      storyDialogueKey(driver.latest) === skipDialogueTail
    )
      return DIALOGUE_SKIP_SPEED;
    return getSpeed();
  }

  // The tape is a keystream: printable keys accumulate into the command line
  // and Enter submits it. Reconstruct typed commands for the activity log.
  let typedLine = "";
  let lastProgressAt = 0;
  let lastProgressActionIndex = -1;

  async function resumed(before: ReplayObservation): Promise<void> {
    if (!before.blocked) return;
    // A key delivered to a waitkey-blocked engine can land it on the next
    // blocking wait — e.g. the save dialog chains waitkey steps. A fresh
    // blocked observation still proves the key was consumed; only a fresh
    // prompt kind (getnum/getstring/saveDescription) needs an answer.
    const stillBlockedOk = before.blocked === "waitkey";
    if (driver.waitForRevision) {
      await driver.waitForRevision(before.revision, {
        unblocked: !stillBlockedOk,
        signal: options?.signal,
      });
    } else {
      const start = Date.now();
      while (
        driver.latest &&
        (driver.latest.revision <= before.revision ||
          (!stillBlockedOk && driver.latest.blocked !== null))
      ) {
        checkAborted();
        if (Date.now() - start > 10_000) {
          throw new Error(`Timeout waiting for revision > ${before.revision}`);
        }
        await sleep(10);
      }
    }
    checkAborted();
  }

  async function checkPaused(): Promise<void> {
    while (options?.isPaused?.() && !isSeeking() && isRunActive()) {
      if (options?.waitForResume) {
        await options.waitForResume();
      } else {
        await sleep(50);
      }
      checkAborted();
    }
  }

  async function advance(ticks: number, actionIndex?: number): Promise<void> {
    let observation = driver.latest;
    if (!observation) throw new Error("No replay observation available");
    const target = observation.tick + ticks;
    while (observation.tick < target) {
      checkAborted();
      await checkPaused();
      checkAborted();
      if (observation.blocked) {
        if (driver.latest && !driver.latest.blocked) {
          observation = driver.latest;
        }
      }
      if (observation.blocked) {
        throw new Error("Route must answer the prompt before advancing time");
      }
      const seekTarget = options?.getSeekTarget?.();
      const advanceLimit =
        seekTarget !== null && seekTarget !== undefined && seekTarget > observation.tick
          ? Math.min(target, seekTarget)
          : target;
      const remaining = advanceLimit - observation.tick;
      if (remaining <= 0) {
        await checkPaused();
        checkAborted();
        if ((options?.getSeekTarget?.() ?? 0) <= observation.tick) {
          if (options?.waitForResume) {
            await options.waitForResume();
          } else {
            await sleep(50);
          }
        }
        checkAborted();
        continue;
      }
      const speed = getEffectiveSpeed();
      if (speed <= 0) {
        const seeking = isSeeking();
        const willReachSeekTarget =
          seekTarget !== null &&
          seekTarget !== undefined &&
          observation.tick + remaining >= seekTarget;
        const renderFinal = !seeking || willReachSeekTarget;
        currentRequestId++;
        updateStatus("advancing", currentRequestId);
        observation = await driver.advance(remaining, {
          sessionId: currentSessionId,
          seeking,
          renderFinal,
        });
        updateStatus("running", currentRequestId);
      } else {
        const currentSpeed = Math.max(0.1, speed);
        const chunk = Math.min(remaining, Math.max(1, Math.round(currentSpeed)));
        const delayMs = Math.max(1, (chunk * (1000 / 60)) / currentSpeed);
        const t0 = performance.now();
        currentRequestId++;
        updateStatus("advancing", currentRequestId);
        observation = await driver.advance(chunk, { sessionId: currentSessionId });
        updateStatus("running", currentRequestId);
        checkAborted();
        const elapsed = performance.now() - t0;
        const remainder = delayMs - elapsed;
        if (remainder > 0) await sleep(remainder);
      }
      checkAborted();
      const dialogueKey = storyDialogueKey(observation);
      if (dialogueKey !== null) {
        if (
          dialogueKey !== pausedDialogueKey &&
          options?.pauseOnDialog?.() &&
          !isSeeking() &&
          getEffectiveSpeed() > 0
        ) {
          pausedDialogueKey = dialogueKey;
          options.onDialogPause?.();
          await checkPaused();
          skipDialogueTail = dialogueKey;
          checkAborted();
        }
      } else {
        skipDialogueTail = null;
      }
      if (options?.onProgress && actionIndex !== undefined && !isSeeking()) {
        const now = performance.now();
        if (now - lastProgressAt >= 100 || actionIndex !== lastProgressActionIndex) {
          lastProgressAt = now;
          lastProgressActionIndex = actionIndex;
          options.onProgress({
            actionIndex,
            totalActions: actions.length,
            tick: observation.tick,
            room: observation.state.room,
            score: observation.state.vars[3] ?? 0,
          });
        }
      }
      if (observation.blocked) {
        if (observation.tick !== target) {
          throw new Error(
            `Record the consumed tick segment before its blocking key (expected tick ${target}, got ${observation.tick})`,
          );
        }
        return;
      }
    }
  }

  async function key(code: number): Promise<void> {
    checkAborted();
    const before = driver.latest;
    if (!before) throw new Error("No replay observation available before key");
    if (code >= 0x20 && code <= 0x7e) typedLine += String.fromCharCode(code);
    else if (code === 0x0d) {
      if (typedLine && !isSeeking()) options?.onAcceptedInput?.(typedLine);
      typedLine = "";
    }
    driver.key(code, currentSessionId);
    checkAborted();
    await resumed(before);
    checkAborted();
  }
  async function direction(dir: number): Promise<void> {
    checkAborted();
    const before = driver.latest;
    if (!before) throw new Error("No replay observation available before direction");
    if (dir === 0 && before.releaseGate === 0) {
      // Tap-to-move profiles have no release event: stop ego by re-pressing
      // the current heading's key word, exactly as the recording did. The
      // recording cycle-waits after every direction change, so the observed
      // heading is exact here.
      const stopKey = DIRECTION_KEYS[before.state.egoDirection];
      if (stopKey !== undefined) driver.key(stopKey, currentSessionId);
    } else {
      driver.direction(dir, currentSessionId);
    }
    checkAborted();
    await resumed(before);
    checkAborted();
  }

  async function answer(text: string): Promise<void> {
    checkAborted();
    const before = driver.latest;
    if (!before) throw new Error("No replay observation available before answer");
    if (!before.blocked || before.blocked === "waitkey") {
      throw new Error("Recorded answer requires a real prompt");
    }
    // The worker posts the host request before the blocking observation, so
    // the resolver is normally installed already; wait out the race instead
    // of dropping the answer.
    const start = Date.now();
    while (!driver.promptPending()) {
      checkAborted();
      if (Date.now() - start > 10_000) {
        throw new Error("Timeout waiting for the blocking prompt to reach the host");
      }
      await sleep(10);
    }
    // Cosmetic typing: the engine is parked inside the blocking prompt, so the
    // echo is presentation-only and paced in real time.
    const speed = getEffectiveSpeed();
    if (speed > 0 && !isSeeking() && text.length > 0) {
      const charDelay = Math.max(5, Math.min(35, Math.round(22 / speed)));
      for (let i = 1; i <= text.length; i++) {
        checkAborted();
        await checkPaused();
        driver.setPromptEcho(text.slice(0, i));
        if (options?.dwellOnDialog) {
          await options.dwellOnDialog(charDelay);
        } else {
          await sleep(charDelay);
        }
      }
    }
    checkAborted();
    driver.answer(text);
    checkAborted();
    await resumed(before);
    checkAborted();
  }

  for (const [index, action] of actions.entries()) {
    checkAborted();
    await checkPaused();
    checkAborted();
    if (driver.latest && options?.onProgress && !isSeeking()) {
      options.onProgress({
        actionIndex: index,
        totalActions: actions.length,
        tick: driver.latest.tick,
        room: driver.latest.state.room,
        score: driver.latest.state.vars[3] ?? 0,
      });
    }
    try {
      switch (action.kind) {
        case "key": {
          const dialogueKey = storyDialogueKey(driver.latest);
          if (dialogueKey !== null) {
            if (
              dialogueKey !== pausedDialogueKey &&
              options?.pauseOnDialog?.() &&
              !isSeeking() &&
              getEffectiveSpeed() > 0
            ) {
              pausedDialogueKey = dialogueKey;
              options.onDialogPause?.();
              await checkPaused();
              skipDialogueTail = dialogueKey;
              checkAborted();
            }
          } else {
            skipDialogueTail = null;
          }
          await key(action.code);
          checkAborted();
          if (getEffectiveSpeed() > 0) {
            await sleep(Math.min(80, Math.max(5, 40 / getEffectiveSpeed())));
            checkAborted();
          }
          break;
        }
        case "direction":
          await direction(action.dir);
          checkAborted();
          break;
        case "answer":
          await answer(action.text);
          checkAborted();
          break;
        case "advance":
          await advance(action.ticks, index);
          checkAborted();
          break;
        case "checkpoint": {
          checkAborted();
          const obs = driver.latest;
          if (!obs) throw new Error("No observation at checkpoint");
          const actual = {
            room: obs.state.room,
            score: obs.state.vars[3] ?? 0,
            x: obs.state.egoX,
            y: obs.state.egoY,
          };
          const expected = {
            room: action.room,
            score: action.score,
            x: action.x,
            y: action.y,
          };
          if (actual.room !== expected.room || actual.score !== expected.score) {
            throw new Error(
              `Checkpoint "${action.label}" failed: expected room ${expected.room} score ${expected.score}, got room ${actual.room} score ${actual.score}`,
            );
          }
          if (actual.x !== expected.x || actual.y !== expected.y) {
            throw new Error(
              `Checkpoint "${action.label}" coordinate failed: expected (${expected.x},${expected.y}), got (${actual.x},${actual.y})`,
            );
          }
          checkAborted();
          if (!isSeeking()) {
            options?.onCheckpoint?.({
              label: action.label,
              room: actual.room,
              score: actual.score,
              x: actual.x,
              y: actual.y,
            });
          }
          break;
        }
      }
    } catch (error) {
      if (!isRunActive() || (error instanceof DOMException && error.name === "AbortError")) {
        updateStatus("stopped");
        throw new DOMException("Replay aborted", "AbortError");
      }
      updateStatus("error");
      const obs = driver.latest;
      throw new Error(
        `Replay action ${index} ${JSON.stringify(action)} at tick ${obs?.tick}: ${String(error)}\n${obs?.rows.join("\n")}`,
        { cause: error },
      );
    }
  }

  checkAborted();
  // The last advance's observation is lean (no flags/strings); take a full
  // snapshot so completion state is verifiable.
  const finalObs = await driver.advance(0, {
    sessionId: currentSessionId,
    fullState: true,
  });
  if (!finalObs) throw new Error("No final observation after batch completion");
  if (options?.onProgress) {
    options.onProgress({
      actionIndex: actions.length,
      totalActions: actions.length,
      tick: finalObs.tick,
      room: finalObs.state.room,
      score: finalObs.state.vars[3] ?? 0,
    });
  }
  const screenHash = await computeScreenHash(options?.getLatestFrame?.() ?? null);
  checkAborted();
  updateStatus("completed");
  return {
    ...finalObs,
    score: finalObs.state.vars[3] ?? 0,
    room: finalObs.state.room,
    screenHash,
  };
}
