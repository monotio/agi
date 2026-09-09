import { AGI_KEY, NAV_KEYS } from "../../src/runtime/keys.ts";
import type { ReplayAction, ReplayBatchResult, ReplayDriver, ReplayObservation } from "./replay.ts";
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
 * Evaluates walkthrough actions directly in-page without CDP roundtripping.
 * Dispatches actual DOM events against app controls and advances virtual ticks.
 */
export async function runReplayBatch(
  driver: ReplayDriver,
  actions: readonly ReplayAction[],
  options?: { phone?: boolean; getLatestFrame?: () => Frame | null },
): Promise<ReplayBatchResult> {
  const phone = options?.phone ?? Boolean(document.querySelector('[data-testid="touch-controls"]'));
  let heldDirection: string | null = null;

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
        if (Date.now() - start > 10_000) {
          throw new Error(`Timeout waiting for revision > ${before.revision}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async function advance(ticks: number): Promise<void> {
    let observation = driver.latest;
    if (!observation) throw new Error("No replay observation available");
    const target = observation.tick + ticks;
    while (observation.tick < target) {
      if (observation.blocked) {
        throw new Error("Route must answer the prompt before advancing time");
      }
      observation = await driver.advance(target - observation.tick);
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
        if (Date.now() - start > 10_000) {
          throw new Error("Timeout waiting for prompt-hint to appear in DOM");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

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
    await resumed(before);
  }

  async function text(inputText: string): Promise<void> {
    const before = driver.latest;
    if (!before) throw new Error("No replay observation available before text");
    if (before.blocked && before.blocked !== "waitkey") {
      const start = Date.now();
      while (!document.querySelector('[data-testid="prompt-hint"]')) {
        if (Date.now() - start > 10_000) {
          throw new Error("Timeout waiting for prompt-hint to appear in DOM");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const input = document.querySelector<HTMLInputElement>('[data-testid="input-line"]');
    if (!input) throw new Error('Input element [data-testid="input-line"] not found');
    if (input.value !== "") {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.value = inputText;
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
    await resumed(before);
  }

  try {
    for (const [index, action] of actions.entries()) {
      try {
        switch (action.kind) {
          case "key":
            await key(action.code);
            break;
          case "command":
            await text(action.text);
            break;
          case "answer":
            if (!driver.latest?.blocked) {
              throw new Error("Recorded answer requires a real prompt");
            }
            await text(action.text);
            break;
          case "advance":
            await advance(action.ticks);
            break;
          case "checkpoint": {
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
            if (
              actual.room !== expected.room ||
              actual.score !== expected.score ||
              actual.x !== expected.x ||
              actual.y !== expected.y
            ) {
              throw new Error(
                `Checkpoint "${action.label}" failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
              );
            }
            break;
          }
        }
      } catch (error) {
        const obs = driver.latest;
        throw new Error(
          `Replay action ${index} ${JSON.stringify(action)} at tick ${obs?.tick}: ${String(error)}\n${obs?.rows.join("\n")}`,
          { cause: error },
        );
      }
    }
  } finally {
    if (heldDirection) {
      releaseDirection();
      heldDirection = null;
    }
  }

  const finalObs = driver.latest;
  if (!finalObs) throw new Error("No final observation after batch completion");
  const screenHash = await computeScreenHash(options?.getLatestFrame?.() ?? null);
  return {
    ...finalObs,
    score: finalObs.state.vars[3] ?? 0,
    room: finalObs.state.room,
    screenHash,
  };
}
