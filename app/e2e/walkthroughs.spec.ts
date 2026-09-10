import { expect, test } from "@playwright/test";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { Speedrun } from "../../test/speedrun/runner.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import {
  WALKTHROUGHS,
  runWalkthrough,
  verifyWalkthrough,
} from "../../test/speedrun/walkthroughs.ts";
import { readWalkthroughArtifact, walkthroughFixtureHashes } from "../../test/speedrun/artifact.ts";
import { BrowserReplay } from "./speedrunReplay.ts";
import { settled } from "./engineProbe.ts";

const path = process.env["AGI_SPEEDRUN_FILE"];
const recording = path ? readWalkthroughArtifact(path) : null;
const missing = fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]);

for (const phone of [false, true]) {
  test.describe(phone ? "phone replay" : "desktop replay", () => {
    test.use({
      hasTouch: phone,
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    });
    test("virtual clock reproduces opening movement through actual controls", async ({ page }) => {
      test.skip(Boolean(missing), missing || "");
      const run = new Speedrun(KNOWN_GAME_HASH.KQ1, 1);
      run.advance(12);
      run.key(AGI_KEY.ENTER);
      run.advance(12);
      run.dismiss();
      run.checkpoint("Daventry", { room: 1, score: 0 });
      run.direction(3);
      run.advance(24);
      run.direction(0);
      run.checkpoint("Stopped east of arrival", { room: 1, score: 0 });
      const replay = new BrowserReplay(page, phone);
      await replay.boot(KNOWN_GAME_HASH.KQ1, run.seed);
      await replay.play(run.actions);
      expect((await replay.read()).tick).toBe(run.ticks);
      for (const letter of "lo") await replay.key(letter.charCodeAt(0));
      await expect(page.getByTestId("input-line")).toHaveValue("lo");
      await page.screenshot({ path: test.info().outputPath("opening-replay.png") });
    });

    for (const route of WALKTHROUGHS) {
      test(`${route.gameId}: ${route.label} through actual controls`, async ({ page }) => {
        const unavailable = fixtureSkip(route.hash, ["AGIDATA.OVL"]);
        test.skip(Boolean(unavailable), unavailable || "");
        test.skip(
          recording !== null && recording.game !== route.gameId,
          "Another walkthrough was selected by AGI_SPEEDRUN_FILE.",
        );
        test.setTimeout(15 * 60_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const run = recording ? null : runWalkthrough(route);
        if (recording)
          expect(recording.fixtureHashes, "exact fixture resources").toEqual(
            walkthroughFixtureHashes(route.hash),
          );
        const seed = recording?.seed ?? run!.seed;
        const actions = recording?.actions ?? run!.actions;
        const ticks = recording?.virtualTicks ?? run!.ticks;
        const replay = new BrowserReplay(page, phone);
        await replay.boot(route.hash, seed);
        if (recording) expect((await replay.read()).state.profile).toBe(recording.profile);
        await replay.play(actions);
        const outcome = await replay.read();
        verifyWalkthrough(route, outcome);
        expect(outcome.tick).toBe(ticks);
        expect(errors).toEqual([]);
        await settled(page);
        // Capture the composed engine frame separately from the GPU screenshot:
        // stopped games can retain stale swapchain images in headless WebKit.
        const probePng = await page
          .getByTestId("game-canvas")
          .evaluate((element) => (element as HTMLCanvasElement).toDataURL("image/png"));
        await test.info().attach("final-engine-frame", {
          body: Buffer.from(probePng.split(",")[1]!, "base64"),
          contentType: "image/png",
        });
        await page.screenshot({ path: test.info().outputPath(`${route.gameId}-milestone.png`) });
      });
    }
  });
}
