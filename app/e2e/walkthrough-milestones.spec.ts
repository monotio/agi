import { expect, test } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import { Speedrun } from "../../test/speedrun/runner.ts";
import { sq1Boulder } from "../../test/speedrun/sq1-opening.ts";
import { kq2Bridge } from "../../test/speedrun/kq2-opening.ts";
import { BrowserReplay } from "./speedrunReplay.ts";

for (const scenario of [
  { slug: "kq2", route: kq2Bridge, room: 48, score: 41, label: "bridge round trip" },
  { slug: "sq1", route: sq1Boulder, room: 19, score: 42, label: "spider droid crushed" },
]) {
  test(`${scenario.slug}: ${scenario.label} through browser controls`, async ({ page }) => {
    const missing = fixtureSkip(scenario.slug, ["AGIDATA.OVL"]);
    test.skip(Boolean(missing), missing || "");
    test.setTimeout(5 * 60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const run = new Speedrun(scenario.slug, 1);
    scenario.route(run);
    const replay = new BrowserReplay(page, false);
    await replay.boot(scenario.slug, run.seed);
    await replay.play(run.actions);
    const observation = await replay.read();
    expect(observation.state.profile).toBe(run.engine.profile.id);
    expect(observation.state.room).toBe(scenario.room);
    expect(observation.state.vars[3]).toBe(scenario.score);
    expect(observation.tick).toBe(run.ticks);
    if (scenario.slug === "kq2") {
      expect(observation.state.flags[67]).toBe(1);
      expect(observation.state.flags[119]).toBe(0);
    } else {
      expect(observation.state.flags[165]).toBe(1);
      expect(observation.state.flags[161]).toBe(1);
      expect(observation.state.vars[108]).toBe(2);
    }
    expect(observation.state.inventory).toEqual(run.engine.readState().inventory);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("milestone.png") });
  });
}
