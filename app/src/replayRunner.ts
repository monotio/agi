import { AGI_KEY, NAV_KEYS } from "../../src/runtime/keys.ts";
import type {
  ReplayAction,
  ReplayBatchOptions,
  ReplayBatchResult,
  ReplayDriver,
  ReplayObservation,
} from "./replay.ts";
import type { Frame } from "./useEngine.ts";

export const REPLAY_KEYS: Record<number, string> = {
  [AGI_KEY.BACKSPACE]: "Backspace",
  [AGI_KEY.TAB]: "Tab",
  [AGI_KEY.ENTER]: "Enter",
  [AGI_KEY.ESCAPE]: "Escape",
  [AGI_KEY.SPACE]: "Space",
  [AGI_KEY.HOME]: "Home",
  [AGI_KEY.UP]: "ArrowUp",
  [AGI_KEY.PAGE_UP]: "PageUp",
  [AGI_KEY.LEFT]: "ArrowLeft",
  [AGI_KEY.RIGHT]: "ArrowRight",
  [AGI_KEY.END]: "End",
  [AGI_KEY.DOWN]: "ArrowDown",
  [AGI_KEY.PAGE_DOWN]: "PageDown",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [AGI_KEY.F1 + (n << 8), `F${n + 1}`])),
};

export const REPLAY_DIRECTIONS: Record<number, string> = {
  [AGI_KEY.HOME]: "northwest",
  [AGI_KEY.UP]: "north",
  [AGI_KEY.PAGE_UP]: "northeast",
  [AGI_KEY.LEFT]: "west",
  [AGI_KEY.RIGHT]: "east",
  [AGI_KEY.END]: "southwest",
  [AGI_KEY.DOWN]: "south",
  [AGI_KEY.PAGE_DOWN]: "southeast",
};

export const REPLAY_DOM_KEYS: Record<number, { key: string; code: string }> = {
  [AGI_KEY.BACKSPACE]: { key: "Backspace", code: "Backspace" },
  [AGI_KEY.TAB]: { key: "Tab", code: "Tab" },
  [AGI_KEY.ENTER]: { key: "Enter", code: "Enter" },
  [AGI_KEY.ESCAPE]: { key: "Escape", code: "Escape" },
  [AGI_KEY.SPACE]: { key: " ", code: "Space" },
  [AGI_KEY.HOME]: { key: "Home", code: "Home" },
  [AGI_KEY.UP]: { key: "ArrowUp", code: "ArrowUp" },
  [AGI_KEY.PAGE_UP]: { key: "PageUp", code: "PageUp" },
  [AGI_KEY.LEFT]: { key: "ArrowLeft", code: "ArrowLeft" },
  [AGI_KEY.RIGHT]: { key: "ArrowRight", code: "ArrowRight" },
  [AGI_KEY.END]: { key: "End", code: "End" },
  [AGI_KEY.DOWN]: { key: "ArrowDown", code: "ArrowDown" },
  [AGI_KEY.PAGE_DOWN]: { key: "PageDown", code: "PageDown" },
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, n) => [
      AGI_KEY.F1 + (n << 8),
      { key: `F${n + 1}`, code: `F${n + 1}` },
    ]),
  ),
};

export async function computeScreenHash(frame: Frame | null): Promise<string> {
  if (frame) {
    const data = new Uint8Array(frame.visual.length + frame.text.length);
    data.set(frame.visual);
    data.set(frame.text, frame.visual.length);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const digest = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  }
  return "";
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
 * Extracts readable words from screen text rows, excluding the top status line.
 */
export function extractDialogWords(rows: readonly string[]): string[] {
  if (!rows || rows.length <= 1) return [];
  // Row 0 is normally the status line (e.g. "Score: 0 Sound: on")
  const content = rows.slice(1).join(" ");
  const matches = content.match(/[A-Za-z0-9']{2,}/g);
  return matches ?? [];
}

/**
 * Calculates a comfortable adaptive reading dwell time in milliseconds based on
 * dialogue word count and current playback speed.
 *
 * Scales inversely with speed, capped between 1.5s and 5.0s at 1x speed.
 * Returns 0 when speed <= 0 (unthrottled / fast-forward / seeking).
 */
export function calculateModalDwellMs(rows: readonly string[], speed: number): number {
  if (speed <= 0) return 0;
  const words = extractDialogWords(rows);
  // ~200 words/min baseline reading pace (1800ms base recognition + 120ms/word)
  const baseMs = 1800;
  const perWordMs = 120;
  const rawMs = Math.min(5000, Math.max(1500, baseMs + words.length * perWordMs));
  return Math.max(50, Math.round(rawMs / Math.max(0.1, speed)));
}

/**
 * Evaluates walkthrough actions directly in-page without CDP roundtripping.
 * Dispatches actual DOM events against app controls and advances virtual ticks.
 */
export async function runReplayBatch(
  driver: ReplayDriver,
  actions: readonly ReplayAction[],
  options?: ReplayBatchOptions & { getLatestFrame?: () => Frame | null },
): Promise<ReplayBatchResult> {
  const phone = options?.phone ?? Boolean(document.querySelector('[data-testid="touch-controls"]'));
  const rawSpeed = options?.speed;
  const getSpeed: () => number = typeof rawSpeed === "function" ? rawSpeed : () => rawSpeed ?? 0;
  let heldDirection: string | null = null;
  const currentSessionId = options?.sessionId ?? driver.sessionId ?? 0;
  let currentRequestId = 0;

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

  function getEffectiveSpeed(): number {
    if (isSeeking()) return 0;
    return getSpeed();
  }

  function releaseDirection(): void {
    if (!heldDirection) return;
    if (phone) {
      const pad = document.querySelector('[data-testid="touch-controls"]');
      if (pad) {
        const regex = new RegExp(`^(Walk|Navigate) ${heldDirection}$`, "i");
        for (const button of pad.querySelectorAll("button")) {
          if (regex.test(button.getAttribute("aria-label") ?? "")) {
            button.dispatchEvent(
              new PointerEvent("pointerup", {
                pointerId: 1,
                pointerType: "touch",
                button: 0,
                bubbles: true,
              }),
            );
            break;
          }
        }
      }
    } else {
      window.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: heldDirection,
          code: heldDirection,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    heldDirection = null;
  }

  async function resumed(before: ReplayObservation): Promise<void> {
    if (!before.blocked) return;
    if (driver.waitForRevision) {
      await driver.waitForRevision(before.revision);
    } else {
      const start = Date.now();
      while (driver.latest && driver.latest.revision <= before.revision) {
        checkAborted();
        if (Date.now() - start > 10_000) {
          throw new Error(`Timeout waiting for revision > ${before.revision}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    checkAborted();
  }

  async function checkPaused(): Promise<void> {
    while (options?.isPaused?.() && !isSeeking() && isRunActive()) {
      if (options?.waitForResume) {
        await options.waitForResume();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
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
            await new Promise((resolve) => setTimeout(resolve, 50));
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
        const sleep = delayMs - elapsed;
        if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));
      }
      checkAborted();
      if (
        options?.pauseOnDialog?.() &&
        isStoryDialogue(observation) &&
        !isSeeking() &&
        getEffectiveSpeed() > 0 &&
        observation.revision !== lastDwelledRevision
      ) {
        lastDwelledRevision = observation.revision;
        options.onDialogPause?.();
        await checkPaused();
        checkAborted();
      }
      if (options?.onProgress && actionIndex !== undefined && !isSeeking()) {
        options.onProgress({
          actionIndex,
          totalActions: actions.length,
          tick: observation.tick,
          room: observation.state.room,
          score: observation.state.vars[3] ?? 0,
        });
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
    const domKey =
      REPLAY_DOM_KEYS[code] ??
      (code >= 33 && code <= 126
        ? { key: String.fromCharCode(code), code: String.fromCharCode(code) }
        : null);
    if (!domKey) throw new Error(`Replay key 0x${code.toString(16)} has no UI mapping.`);

    // A held walking pointer must end before the pad can accept dialog taps.
    if (before.state.modalKind !== null) releaseDirection();

    if (before.blocked && before.blocked !== "waitkey") {
      const start = Date.now();
      while (!document.querySelector('[data-testid="prompt-hint"]')) {
        checkAborted();
        if (Date.now() - start > 10_000) {
          throw new Error("Timeout waiting for prompt-hint to appear in DOM");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    checkAborted();

    if (before.releaseGate !== 0 && REPLAY_DIRECTIONS[code] && before.state.modalKind === null) {
      releaseDirection();
      if (before.state.egoDirection !== NAV_KEYS[code]) {
        heldDirection = phone ? REPLAY_DIRECTIONS[code]! : domKey.key;
        if (phone) {
          const pad = document.querySelector('[data-testid="touch-controls"]');
          if (pad) {
            const regex = new RegExp(`^Walk ${heldDirection}$`, "i");
            for (const button of pad.querySelectorAll("button")) {
              if (regex.test(button.getAttribute("aria-label") ?? "")) {
                button.dispatchEvent(
                  new PointerEvent("pointerdown", {
                    pointerId: 1,
                    pointerType: "touch",
                    button: 0,
                    bubbles: true,
                  }),
                );
                break;
              }
            }
          }
        } else {
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: domKey.key,
              code: domKey.code,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      }
    } else if (!phone) {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: domKey.key,
          code: domKey.code,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: domKey.key,
          code: domKey.code,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (code >= 33 && code <= 126) {
      const input = document.querySelector<HTMLInputElement>('[data-testid="input-line"]');
      if (input) {
        input.value = input.value + domKey.key;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      const pad = document.querySelector('[data-testid="touch-controls"]');
      const direction = REPLAY_DIRECTIONS[code];
      if (direction && pad) {
        const regex = new RegExp(`^(Walk|Navigate) ${direction}$`, "i");
        for (const button of pad.querySelectorAll("button")) {
          if (regex.test(button.getAttribute("aria-label") ?? "")) {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            break;
          }
        }
      } else if (pad) {
        const label = domKey.key === "Escape" ? "Esc" : domKey.key;
        let button: HTMLButtonElement | null = null;
        for (const btn of pad.querySelectorAll("button")) {
          if (btn.textContent?.trim() === label) {
            button = btn;
            break;
          }
        }
        if (!button) {
          const summary = pad.querySelector("summary");
          if (summary && summary.textContent?.trim() === "Keys") {
            summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            for (const btn of pad.querySelectorAll("button")) {
              if (btn.textContent?.trim() === label) {
                button = btn;
                break;
              }
            }
          }
        }
        if (button) {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        } else {
          throw new Error(`Button "${label}" not found in touch controls.`);
        }
      }
    }
    checkAborted();
    await resumed(before);
    checkAborted();
  }

  async function text(inputText: string): Promise<void> {
    checkAborted();
    const before = driver.latest;
    if (!before) throw new Error("No replay observation available before text");
    if (before.blocked && before.blocked !== "waitkey") {
      const start = Date.now();
      while (!document.querySelector('[data-testid="prompt-hint"]')) {
        checkAborted();
        if (Date.now() - start > 10_000) {
          throw new Error("Timeout waiting for prompt-hint to appear in DOM");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    checkAborted();
    const input = document.querySelector<HTMLInputElement>('[data-testid="input-line"]');
    if (!input) throw new Error('Input element [data-testid="input-line"] not found');
    const speed = getEffectiveSpeed();
    if (speed > 0 && !isSeeking() && inputText.length > 0) {
      const charDelay = Math.max(5, Math.min(35, Math.round(22 / speed)));
      if (input.value !== "") {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      let completedTyping = true;
      let skipped = false;
      for (let i = 1; i <= inputText.length; i++) {
        checkAborted();
        if (isSeeking()) {
          completedTyping = false;
          break;
        }
        await checkPaused();
        checkAborted();
        if (isSeeking()) {
          completedTyping = false;
          break;
        }
        input.value = inputText.slice(0, i);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (charDelay > 0 && !skipped && i < inputText.length) {
          const t0 = Date.now();
          if (options?.dwellOnDialog) {
            await options.dwellOnDialog(charDelay);
          } else {
            await new Promise((resolve) => setTimeout(resolve, charDelay));
          }
          checkAborted();
          if (Date.now() - t0 < Math.max(1, charDelay / 2)) {
            skipped = true;
          }
        }
      }
      checkAborted();
      if (!completedTyping) {
        input.value = inputText;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (!skipped) {
        const enterDelay = Math.max(15, Math.min(120, Math.round(80 / speed)));
        if (options?.dwellOnDialog) {
          await options.dwellOnDialog(enterDelay);
        } else {
          await new Promise((resolve) => setTimeout(resolve, enterDelay));
        }
        checkAborted();
      }
    } else {
      if (input.value !== "") {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.value = inputText;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    checkAborted();
    if (phone) {
      const pad = document.querySelector('[data-testid="touch-controls"]');
      const enterBtn = Array.from(pad?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent?.trim() === "Enter",
      );
      if (!enterBtn) throw new Error("Enter button not found in touch controls");
      enterBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } else {
      if (input.form) {
        input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } else {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    checkAborted();
    await resumed(before);
    checkAborted();
  }

  let lastDwelledRevision: number | null = null;

  try {
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
          case "key":
            if (
              driver.latest &&
              isStoryDialogue(driver.latest) &&
              !isSeeking() &&
              getEffectiveSpeed() > 0 &&
              driver.latest.revision !== lastDwelledRevision
            ) {
              lastDwelledRevision = driver.latest.revision;
              if (options?.pauseOnDialog?.()) {
                options.onDialogPause?.();
                await checkPaused();
                checkAborted();
              }
            }
            await key(action.code);
            checkAborted();
            if (getEffectiveSpeed() > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(80, Math.max(5, 40 / getEffectiveSpeed()))),
              );
              checkAborted();
            }
            break;
          case "command":
            await text(action.text);
            checkAborted();
            if (getEffectiveSpeed() > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(100, Math.max(8, 60 / getEffectiveSpeed()))),
              );
              checkAborted();
            }
            break;
          case "answer":
            if (!driver.latest?.blocked) {
              throw new Error("Recorded answer requires a real prompt");
            }
            await text(action.text);
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
  } finally {
    if (heldDirection) {
      if (isRunActive()) {
        releaseDirection();
      }
      heldDirection = null;
    }
  }

  checkAborted();
  const finalObs = driver.latest;
  if (!finalObs) throw new Error("No final observation after batch completion");
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
