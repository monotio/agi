import { expect, test } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import { ADDITIONAL_OPENINGS, additionalOpening } from "../../test/speedrun/additional-openings.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { BrowserReplay } from "./speedrunReplay.ts";

// Opening-room checks exercise development discovery, loading and the worker.
// Complete resource validation is a separate fixtures:audit command.
for (const game of [
  { slug: "bc", profile: "2.440", room: 67 },
  { slug: "ddp", profile: "2.272", room: 1 },
  { slug: "demopac4", profile: "3.002.102", room: 1 },
  { slug: "gr1", profile: "3.002.149", room: 129 },
  { slug: "kq1", profile: "2.917", room: 83 },
  { slug: "kq2", profile: "2.411", room: 97 },
  { slug: "kq3", profile: "2.936", room: 45 },
  { slug: "kq4", profile: "3.002.086", room: 140 },
  { slug: "lsl1", profile: "2.440", room: 1 },
  { slug: "mh1", profile: "3.002.102", room: 153 },
  { slug: "mh2", profile: "3.002.149", room: 153 },
  { slug: "mumg", profile: "2.917", room: 96 },
  { slug: "pq1", profile: "2.936", room: 1 },
  { slug: "sq1", profile: "2.917", room: 67 },
  { slug: "sq2", profile: "2.936", room: 140 },
]) {
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
      .poll(async () => (await textHook(page)).profile, { timeout: 30_000 })
      .toBe(game.profile);
    await page.evaluate(() => window.__AGI_REPLAY__!.advance(1));
    await expect.poll(async () => (await textHook(page)).room).toBe(game.room);
    await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("title.png") });
  });
}

for (const game of ADDITIONAL_OPENINGS) {
  const missing = fixtureSkip(game.slug, ["AGIDATA.OVL"]);
  test(`${game.slug}: browser replays the opening through player-controlled movement`, async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    const run = additionalOpening(game.slug);
    const replay = new BrowserReplay(page, false, game.slug === "mumg");
    await replay.boot(game.slug, run.seed);
    await replay.play(run.actions);
    expect((await replay.read()).state.profile).toBe(game.profile);
    expect((await replay.read()).state.room).toBe(game.room);
    await page.screenshot({ path: test.info().outputPath("player-control.png") });
  });
}
