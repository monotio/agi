import { expect, type Page } from "@playwright/test";
import type { Action } from "../../test/speedrun/runner.ts";
import type { ReplayObservation } from "../src/replay.ts";
import { isolateStorage } from "./engineProbe.ts";

const KEYS: Record<number, string> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  27: "Escape",
  32: "Space",
  0x4700: "Home",
  0x4800: "ArrowUp",
  0x4900: "PageUp",
  0x4b00: "ArrowLeft",
  0x4d00: "ArrowRight",
  0x4f00: "End",
  0x5000: "ArrowDown",
  0x5100: "PageDown",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [(0x3b + n) << 8, `F${n + 1}`])),
};
const DIRECTIONS: Record<number, string> = {
  0x4700: "northwest",
  0x4800: "north",
  0x4900: "northeast",
  0x4b00: "west",
  0x4d00: "east",
  0x4f00: "southwest",
  0x5000: "south",
  0x5100: "southeast",
};

/** Only time is privileged. Every player action crosses the visible app controls. */
export class BrowserReplay {
  readonly page: Page;
  readonly phone: boolean;
  readonly holdMovement: boolean;
  private heldDirection: string | null = null;

  constructor(page: Page, phone: boolean, holdMovement = false) {
    this.page = page;
    this.phone = phone;
    this.holdMovement = holdMovement;
  }

  async boot(slug: string, seed: number): Promise<void> {
    await isolateStorage(this.page);
    await this.page.goto(`/?replaySeed=${seed}`);
    const boot = this.page.getByTestId(`boot-${slug}`);
    if (this.phone) await boot.tap();
    else await boot.press("Enter");
    await expect
      .poll(() => this.page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick), {
        timeout: 30_000,
      })
      .toBe(0);
  }

  async read(): Promise<ReplayObservation> {
    const observation = await this.page.evaluate(() => window.__AGI_REPLAY__?.latest);
    if (!observation) throw new Error("Test-only replay clock was not booted.");
    return observation;
  }

  private async resumed(from: ReplayObservation): Promise<void> {
    if (!from.blocked) return;
    await expect.poll(async () => (await this.read()).revision).toBeGreaterThan(from.revision);
  }

  async key(code: number): Promise<void> {
    const before = await this.read();
    const key = KEYS[code] ?? (code >= 33 && code <= 126 ? String.fromCharCode(code) : null);
    if (!key) throw new Error(`Replay key 0x${code.toString(16)} has no UI mapping.`);
    if (!this.phone && this.holdMovement && DIRECTIONS[code] && before.state.modalKind === null) {
      // A second direction event stops the Node route. In hold.key games the
      // equivalent physical input is keyup, with time advancing while held.
      const previous = this.heldDirection;
      if (previous) await this.page.keyboard.up(previous);
      this.heldDirection = previous === key ? null : key;
      if (this.heldDirection) await this.page.keyboard.down(this.heldDirection);
    } else if (!this.phone) await this.page.keyboard.press(key);
    else {
      const pad = this.page.getByTestId("touch-controls");
      const direction = DIRECTIONS[code];
      if (direction) {
        await pad.getByRole("button", { name: new RegExp(`^(Walk|Navigate) ${direction}$`) }).tap();
      } else {
        const label = key === "Escape" ? "Esc" : key;
        let button = pad.getByRole("button", { name: label, exact: true });
        if (!(await button.isVisible())) {
          await pad.getByText("Keys", { exact: true }).tap();
          button = pad.getByRole("button", { name: label, exact: true });
        }
        await button.tap();
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
        .tap();
    else await input.press("Enter");
    await this.resumed(before);
  }

  async advance(ticks: number): Promise<void> {
    const target = (await this.read()).tick + ticks;
    for (;;) {
      let observation = await this.read();
      if (observation.tick === target) return;
      expect(observation.blocked, "Route must answer the prompt before advancing time").toBeNull();
      observation = await this.page.evaluate(
        (count) => window.__AGI_REPLAY__!.advance(count),
        target - observation.tick,
      );
      if (observation.blocked) {
        expect(observation.tick, "Record the consumed tick segment before its blocking key").toBe(
          target,
        );
        return;
      }
    }
  }

  async play(actions: readonly Action[]): Promise<void> {
    for (const [index, action] of actions.entries()) {
      try {
        switch (action.kind) {
          case "key":
            await this.key(action.code);
            break;
          case "command":
            await this.text(action.text);
            break;
          case "answer":
            expect(
              (await this.read()).blocked,
              "Recorded answer requires a real prompt",
            ).not.toBeNull();
            await this.text(action.text);
            break;
          case "advance":
            await this.advance(action.ticks);
            break;
          case "checkpoint": {
            const { state } = await this.read();
            expect(
              { room: state.room, score: state.vars[3], x: state.egoX, y: state.egoY },
              action.label,
            ).toEqual({ room: action.room, score: action.score, x: action.x, y: action.y });
            break;
          }
        }
      } catch (error) {
        const observation = await this.read();
        throw new Error(
          `Replay action ${index} ${JSON.stringify(action)} at tick ${observation.tick}: ${String(error)}\n${observation.rows.join("\n")}`,
          { cause: error },
        );
      }
    }
  }
}
