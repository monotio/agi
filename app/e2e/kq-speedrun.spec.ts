import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { fixtureDir, fixtureSkip } from "../../test/fixtures.ts";
import { Speedrun, type Action } from "../../test/speedrun/runner.ts";
import { BrowserReplay } from "./speedrunReplay.ts";
import { settled } from "./engineProbe.ts";

const missing = fixtureSkip("kq1", ["AGIDATA.OVL"]);

for (const phone of [false, true]) {
  test.describe(phone ? "phone replay" : "desktop replay", () => {
    test.use({
      hasTouch: phone,
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    });

    test("virtual clock reproduces opening movement through actual controls", async ({ page }) => {
      test.skip(Boolean(missing), missing || "");
      const run = new Speedrun("kq1", 1);
      run.advance(12);
      run.key(13);
      run.advance(12);
      run.dismiss();
      run.checkpoint("Daventry", { room: 1, score: 0 });
      run.direction(3);
      run.advance(24);
      run.direction(0);
      run.checkpoint("Stopped east of arrival", { room: 1, score: 0 });
      const replay = new BrowserReplay(page, phone);
      await replay.boot("kq1", run.seed);
      await replay.play(run.actions);
      expect((await replay.read()).tick).toBe(run.ticks);
      await page.screenshot({ path: test.info().outputPath("opening-replay.png") });
    });

    test("recorded walkthrough reaches the completed game using actual controls", async ({
      page,
    }) => {
      test.skip(Boolean(missing), missing || "");
      const path = process.env["AGI_SPEEDRUN_FILE"];
      test.skip(!path, "Set AGI_SPEEDRUN_FILE to a locally generated KQ1 walkthrough replay.");
      test.setTimeout(15 * 60_000);
      const recording = JSON.parse(readFileSync(path!, "utf8")) as {
        schema: string;
        game: string;
        profile: string;
        status: string;
        fixtureHashes: Record<string, string>;
        seed: number;
        actions: Action[];
      };
      expect(recording.schema).toBe("monotio_agi.walkthrough.v1");
      expect(recording.game).toBe("kq1");
      const hashes = Object.fromEntries(
        readdirSync(fixtureDir("kq1"))
          .filter((name) =>
            /^(LOGDIR|PICDIR|VIEWDIR|SNDDIR|WORDS\.TOK|OBJECT|VOL\.\d+|AGIDATA\.OVL)$/.test(name),
          )
          .map((name) => [
            name,
            createHash("sha256")
              .update(readFileSync(fixtureDir("kq1") + name))
              .digest("hex"),
          ]),
      );
      expect(recording.fixtureHashes, "Replay must match these exact local game resources").toEqual(
        hashes,
      );
      const replay = new BrowserReplay(page, phone);
      await replay.boot("kq1", recording.seed);
      expect((await replay.read()).state.profile).toBe(recording.profile);
      await replay.play(recording.actions);
      const { state, egoView } = await replay.read();
      expect(recording.status).toBe("completed");
      expect(state.room).toBe(53);
      expect(state.vars[3], "Completed route score").toBe(159);
      expect(state.vars[74], "All three treasures returned").toBe(3);
      expect(state.flags[195], "Ending credits completed").toBe(1);
      expect(state.inputEnabled).toBe(false);
      expect(egoView, "Royal ending view").toBe(142);
      await settled(page);
      // Headless WebKit captures can rotate stale WebGPU swapchain images after
      // the engine stops. Keep its composed frame as separate evidence; the GPU
      // screenshot is a review artifact, not an exact presentation assertion.
      const probePng = await page
        .getByTestId("game-canvas")
        .evaluate((element) => (element as HTMLCanvasElement).toDataURL("image/png"));
      await test.info().attach("final-engine-frame", {
        body: Buffer.from(probePng.split(",")[1]!, "base64"),
        contentType: "image/png",
      });
      await page.screenshot({ path: test.info().outputPath("kq1-complete.png") });
    });
  });
}
