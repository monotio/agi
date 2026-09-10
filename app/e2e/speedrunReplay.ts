import { expect, type Page } from "@playwright/test";
import { AGI_KEY, NAV_KEYS } from "../../src/runtime/keys.ts";
import type { Action } from "../../test/speedrun/runner.ts";
import type { ReplayObservation, ReplayBatchResult } from "../src/replay.ts";
import { isolateStorage } from "./engineProbe.ts";

const KEYS: Record<number, string> = {
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
const DIRECTIONS: Record<number, string> = {
  [AGI_KEY.HOME]: "northwest",
  [AGI_KEY.UP]: "north",
  [AGI_KEY.PAGE_UP]: "northeast",
  [AGI_KEY.LEFT]: "west",
  [AGI_KEY.RIGHT]: "east",
  [AGI_KEY.END]: "southwest",
  [AGI_KEY.DOWN]: "south",
  [AGI_KEY.PAGE_DOWN]: "southeast",
};

/** Only time is privileged. Every player action crosses the visible app controls. */
export class BrowserReplay {
  readonly page: Page;
  readonly phone: boolean;
  private heldDirection: string | null = null;
  private cachedObservation: ReplayObservation | null = null;

  constructor(page: Page, phone: boolean) {
    this.page = page;
    this.phone = phone;
  }

  async boot(target: string, seed: number): Promise<void> {
    await isolateStorage(this.page);
    await this.page.goto(`/?replaySeed=${seed}`);
    const boot = this.page
      .locator(
        `[data-hash="${target}"], [data-project-id="${target}"], [data-game-id="${target}"], [data-testid="boot-${target}"]`,
      )
      .first();
    if (this.phone) await boot.tap();
    else await boot.press("Enter");
    await expect
      .poll(() => this.page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick), {
        timeout: 30_000,
      })
      .toBe(0);
    this.cachedObservation = null;
  }

  async read(force = false): Promise<ReplayObservation> {
    if (!force && this.cachedObservation) return this.cachedObservation;
    const observation = await this.page.evaluate(() => window.__AGI_REPLAY__?.latest);
    if (!observation) throw new Error("Test-only replay clock was not booted.");
    this.cachedObservation = observation;
    return observation;
  }

  private async resumed(from: ReplayObservation): Promise<void> {
    if (!from.blocked) {
      this.cachedObservation = null;
      return;
    }
    await expect.poll(async () => (await this.read(true)).revision).toBeGreaterThan(from.revision);
  }

  private async releaseDirection(): Promise<void> {
    if (!this.heldDirection) return;
    if (this.phone) {
      await this.page
        .getByTestId("touch-controls")
        .getByRole("button", { name: new RegExp(`^(Walk|Navigate) ${this.heldDirection}$`) })
        .dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", button: 0 });
    } else await this.page.keyboard.up(this.heldDirection);
    this.heldDirection = null;
  }

  async key(code: number): Promise<void> {
    const before = await this.read();
    const key = KEYS[code] ?? (code >= 33 && code <= 126 ? String.fromCharCode(code) : null);
    if (!key) throw new Error(`Replay key 0x${code.toString(16)} has no UI mapping.`);
    // A held walking pointer must end before the pad can accept dialog taps.
    if (before.state.modalKind !== null) await this.releaseDirection();
    if (before.releaseGate !== 0 && DIRECTIONS[code] && before.state.modalKind === null) {
      // A raw navigation word toggles the Node direction. Preserve that
      // gesture through physical key or touch-pointer holds until its stop.
      await this.releaseDirection();
      if (before.state.egoDirection !== NAV_KEYS[code]) {
        this.heldDirection = this.phone ? DIRECTIONS[code]! : key;
        if (this.phone) {
          await this.page
            .getByTestId("touch-controls")
            .getByRole("button", { name: new RegExp(`^Walk ${this.heldDirection}$`) })
            .dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });
        } else await this.page.keyboard.down(key);
      }
    } else if (!this.phone) await this.page.keyboard.press(key);
    else if (code >= 33 && code <= 126) {
      // Native phone typing preserves case, including uppercase game bindings.
      const input = this.page.getByTestId("input-line");
      await input.fill((await input.inputValue()) + key);
    } else {
      const pad = this.page.getByTestId("touch-controls");
      const direction = DIRECTIONS[code];
      if (direction) {
        await pad
          .getByRole("button", { name: new RegExp(`^(Walk|Navigate) ${direction}$`) })
          .dispatchEvent("click");
      } else {
        const label = key === "Escape" ? "Esc" : key;
        let button = pad.getByRole("button", { name: label, exact: true });
        if (!(await button.isVisible())) {
          await pad.getByText("Keys", { exact: true }).dispatchEvent("click");
          button = pad.getByRole("button", { name: label, exact: true });
        }
        await button.dispatchEvent("click");
      }
    }
    await this.resumed(before);
  }

  async text(text: string): Promise<void> {
    const before = await this.read();
    if (before.blocked && before.blocked !== "waitkey")
      await expect(this.page.getByTestId("prompt-hint")).toBeVisible();
    const input = this.page.getByTestId("input-line");
    await input.fill(text);
    if (this.phone)
      await this.page
        .getByTestId("touch-controls")
        .getByRole("button", { name: "Enter", exact: true })
        .dispatchEvent("click");
    else await input.press("Enter");
    await this.resumed(before);
  }

  async advance(ticks: number): Promise<void> {
    let observation = await this.read();
    const target = observation.tick + ticks;
    while (observation.tick < target) {
      expect(observation.blocked, "Route must answer the prompt before advancing time").toBeNull();
      observation = await this.page.evaluate(
        (count) => window.__AGI_REPLAY__!.advance(count),
        target - observation.tick,
      );
      this.cachedObservation = observation;
      if (observation.blocked) {
        expect(observation.tick, "Record the consumed tick segment before its blocking key").toBe(
          target,
        );
        return;
      }
    }
  }

  async play(actions: readonly Action[]): Promise<ReplayBatchResult> {
    // Playback drives the worker input path directly; `phone` only selects the
    // UI shell (touch controls stay on the human-only paths exercised above).
    const result = await this.page.evaluate(
      (batch) => window.__AGI_REPLAY__!.playBatch(batch),
      actions,
    );
    this.cachedObservation = result;
    return result;
  }
}
