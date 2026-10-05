import { expect, test, type Page } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import {
  gameHint,
  isolateStorage,
  revealFoldedBoot,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

const fixtures = [
  {
    alias: "pq1-amiga",
    executable: "PQ",
    profile: "amiga-2.310",
    room: 6,
    start: [60, 120],
    targets: [
      { name: "horizontal", screen: [136, 128], ego: [65, 120] },
      { name: "vertical", screen: [126, 124], ego: [60, 116] },
      { name: "diagonal", screen: [136, 124], ego: [65, 116] },
    ],
  },
  {
    alias: "sq1-amiga",
    executable: "Sierra",
    profile: "amiga-2.082",
    room: 2,
    start: [97, 66],
    targets: [
      { name: "horizontal", screen: [210, 74], ego: [102, 66] },
      { name: "vertical", screen: [200, 78], ego: [97, 70] },
      { name: "diagonal", screen: [210, 78], ego: [102, 70] },
    ],
  },
] as const;

/** Finish the original timed introduction through its visible text windows. */
async function settleOpening(page: Page): Promise<void> {
  const until = (await textHook(page)).cycle + 60;
  for (let observation = 0; observation < 150; observation++) {
    const state = await textHook(page);
    if (state.modal === "print") {
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__AGI_TEXT__?.modal !== "print");
    } else if (state.cycle >= until) return;
    else {
      await page.waitForFunction(
        (after) =>
          (window.__AGI_TEXT__?.cycle ?? 0) > after || window.__AGI_TEXT__?.modal === "print",
        state.cycle,
      );
    }
  }
  throw new Error("The original opening did not finish within the observed cycle limit.");
}

for (const fixture of fixtures) {
  const missing = fixtureSkip(fixture.alias, [fixture.executable]);
  for (const target of fixture.targets) {
    test(`${fixture.alias}: original opening room settles at ${target.name} canvas click @webkit-desktop`, async ({
      page,
    }) => {
      test.skip(Boolean(missing), missing || "");
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await isolateStorage(page);
      await page.goto("/");
      await revealFoldedBoot(page, fixture.alias);
      await page.locator(`[data-alias="${fixture.alias}"]`).press("Enter");
      await expect
        .poll(async () => (await textHook(page)).profile, { timeout: 30_000 })
        .toBe(fixture.profile);
      expect((await textHook(page)).profileKind).toBe("binary");
      await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
      // The original opening accepts Enter; keep the shipped LOGIC and boot
      // state intact, rather than setting restart flags or jumping rooms.
      if ((await textHook(page)).room !== fixture.room) await page.keyboard.press("Enter");
      if (fixture.alias === "sq1-amiga") {
        await expect(await gameHint(page, "prompt-hint")).toBeVisible();
        await page.mouse.move(0, 0);
        await page.getByTestId("input-line").fill("Roger");
        await page.getByTestId("input-line").press("Enter");
      }
      await expect
        .poll(
          async () => {
            const state = await textHook(page);
            return [state.room, state.egoX, state.egoY, state.modal];
          },
          { timeout: 30_000 },
        )
        .toEqual([fixture.room, ...fixture.start, null]);
      if (fixture.alias === "sq1-amiga") await settleOpening(page);
      await waitForCycles(page, 2);
      const box = await page.locator(".game-surface:visible").boundingBox();
      if (!box) throw new Error("No game canvas for the pointer acceptance check.");
      await page.mouse.click(
        box.x + ((target.screen[0] + 0.5) * box.width) / 320,
        box.y + ((target.screen[1] + 0.5) * box.height) / 200,
      );
      // Start the settling interval from a heartbeat after input delivery.
      await expect
        .poll(async () => {
          const state = await textHook(page);
          return [state.egoX, state.egoY];
        })
        .not.toEqual(fixture.start);
      await waitForCycles(page, 12);
      const arrived = await textHook(page);
      expect([arrived.egoX, arrived.egoY]).toEqual(target.ego);
      await waitForCycles(page, 4);
      const settled = await textHook(page);
      expect([settled.egoX, settled.egoY]).toEqual(target.ego);
      expect(errors).toEqual([]);
      await page.screenshot({ path: test.info().outputPath("pointer-arrival.png") });
    });
  }
}
