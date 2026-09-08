import { expect, test } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import { OPENING_ROUTES, TITLE_SCREENS, openingRoute } from "../../test/speedrun/openings.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { BrowserReplay } from "./speedrunReplay.ts";

// Opening-room checks exercise development discovery, loading and the worker.
// Complete resource validation is a separate fixtures:audit command.
for (const game of TITLE_SCREENS) {
  const missing = fixtureSkip(game.slug, ["AGIDATA.OVL"], { checkVolumes: false });
  test(`${game.slug}: gallery opens the fixture in its expected profile and title room`, async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await isolateStorage(page);
    await page.goto("/?replaySeed=1");
    await page.getByTestId(`boot-${game.slug}`).press("Enter");
    await expect
      .poll(async () => game.profiles.includes((await textHook(page)).profile ?? ""), {
        timeout: 30_000,
      })
      .toBe(true);
    await page.evaluate(() => window.__AGI_REPLAY__!.advance(1));
    await expect.poll(async () => (await textHook(page)).room).toBe(game.titleRoom);
    await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("title.png") });
  });
}

for (const game of OPENING_ROUTES) {
  const { slug } = game;
  const missing = fixtureSkip(slug, ["AGIDATA.OVL"]);
  test(`${slug}: browser replays the opening through player-controlled movement`, async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const run = openingRoute(slug);
    const replay = new BrowserReplay(page, false, game.holdMovement);
    await replay.boot(slug, run.seed);
    await replay.play(run.actions);
    expect((await replay.read()).state.profile).toBe(run.engine.profile.id);
    expect((await replay.read()).state.room).toBe(game.openingRoom);
    await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("player-control.png") });
  });
}
