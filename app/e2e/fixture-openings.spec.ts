import { expect, test } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import { OPENING_ROUTES, TITLE_SCREENS, openingRoute } from "../../test/speedrun/openings.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { BrowserReplay } from "./speedrunReplay.ts";

// Opening-room checks exercise development discovery, loading and the worker.
// Complete resource validation is a separate fixtures:audit command.
for (const game of TITLE_SCREENS) {
  // The alias resolves by fixture folder first; a hash query throws when an
  // imported project under games/ duplicates a fixture's WORDS.TOK.
  const missing = fixtureSkip(game.alias, ["AGIDATA.OVL"], { checkVolumes: false });
  test(`${game.alias}: gallery opens the fixture in its expected profile and title room`, async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await isolateStorage(page);
    await page.goto("/?replaySeed=1");
    await page
      .locator(
        `[data-hash="${game.hash}"], [data-alias="${game.alias}"], [data-testid="boot-${game.alias}"]`,
      )
      .first()
      .press("Enter");
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
  const { alias, hash } = game;
  const missing = fixtureSkip(alias, ["AGIDATA.OVL"]);
  test(`${alias}: browser replays the opening through player-controlled movement`, async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const run = openingRoute(hash);
    const replay = new BrowserReplay(page, false);
    await replay.boot(hash, run.seed);
    await replay.play(run.actions);
    expect((await replay.read()).state.profile).toBe(run.engine.profile.id);
    expect((await replay.read()).state.room).toBe(game.openingRoom);
    await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("player-control.png") });
  });
}
