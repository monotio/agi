import { expect, test } from "./test.ts";
import { readFileSync } from "node:fs";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { Speedrun, type Action } from "../../test/speedrun/runner.ts";
import { AGI_KEY } from "../../src/runtime/keys.ts";
import { WALKTHROUGHS, verifyWalkthrough } from "../../test/speedrun/walkthroughs.ts";
import {
  readWalkthroughArtifact,
  shippedTapePath,
  walkthroughFixtureHashes,
} from "../../test/speedrun/artifact.ts";
import { BrowserReplay } from "./speedrunReplay.ts";
import { settled } from "./engineProbe.ts";

// Node proves every shipped tape against its route (test/walkthroughs-*.test.ts).
// These replays prove the app's worker plays the same tapes to the same state.
test.use({ viewport: { width: 1280, height: 900 } });

const path = process.env["AGI_SPEEDRUN_FILE"];
const recording = path ? await readWalkthroughArtifact(path) : null;
const missing = fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]);

/**
 * Tapes replayed whole on every run, one per input path and interpreter
 * profile: parser typing and wait-key (KQ1, 2.917), the cursor interface and
 * name prompts (MH2, 3.002.149), a keys-only game (DDP, 2.440) and a number
 * prompt (the synthetic chamber, 2.936). Every other tape replays its opening
 * here and its whole length under `npm --prefix app run e2e:walkthrough-full`.
 */
const WHOLE_ON_EVERY_RUN = new Set(["kq1", "mh2", "ddp", "synthetic"]);
/** An opening ends at the tape's first checkpoint at or past this tick. */
const OPENING_TICKS = 15_000;

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
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
  });
}

function ticksOf(actions: readonly Action[]): number {
  return actions.reduce((sum, action) => sum + (action.kind === "advance" ? action.ticks : 0), 0);
}

/** A tape's opening: its actions through the first checkpoint at or past `ticks`. */
function openingLength(actions: readonly Action[], ticks: number): number {
  let tick = 0;
  for (const [index, action] of actions.entries()) {
    if (action.kind === "advance") tick += action.ticks;
    if (action.kind === "checkpoint" && tick >= ticks) return index + 1;
  }
  return actions.length;
}

interface TapeReplay {
  route: (typeof WALKTHROUGHS)[number];
  /** Actions replayed from the start of the tape. */
  length: number;
  /** Virtual ticks the replay covers; the longest replays start first. */
  ticks: number;
  title: string;
}

const replays: TapeReplay[] = [];
for (const route of WALKTHROUGHS) {
  if (recording !== null && recording.identity.project !== route.alias) continue;
  const actions =
    recording?.actions ??
    (JSON.parse(readFileSync(shippedTapePath(route.alias), "utf8")) as { actions: Action[] })
      .actions;
  const whole = { route, length: actions.length, ticks: ticksOf(actions) };
  const length =
    recording !== null || WHOLE_ON_EVERY_RUN.has(route.alias)
      ? actions.length
      : openingLength(actions, OPENING_TICKS);
  if (length === actions.length) {
    replays.push({ ...whole, title: `${route.alias}: ${route.label}, from the whole tape` });
    continue;
  }
  const last = actions[length - 1]!;
  replays.push(
    {
      route,
      length,
      ticks: ticksOf(actions.slice(0, length)),
      title: `${route.alias}: the tape's opening, to "${last.kind === "checkpoint" ? last.label : ""}"`,
    },
    { ...whole, title: `${route.alias}: ${route.label}, from the whole tape @walkthrough-full` },
  );
}

// Longest first, so the slowest replay starts while the other workers are busy.
for (const { route, length, title } of replays.sort((a, b) => b.ticks - a.ticks)) {
  test(title, async ({ page }) => {
    const unavailable = fixtureSkip(route.hash, ["AGIDATA.OVL"], { checkVolumes: "shipped" });
    test.skip(Boolean(unavailable), unavailable || "");
    test.setTimeout(15 * 60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const tape = recording ?? (await readWalkthroughArtifact(shippedTapePath(route.alias)));
    expect(tape.fixtureHashes, "exact fixture resources").toEqual(
      walkthroughFixtureHashes(route.hash),
    );
    const replay = new BrowserReplay(page, false);
    await replay.boot(route.hash, tape.seed);
    expect((await replay.read()).state.profile).toBe(tape.profile);
    const actions = tape.actions.slice(0, length);
    await replay.play(actions);
    const outcome = await replay.read();
    if (length === tape.actions.length) {
      verifyWalkthrough(route, outcome);
      expect(outcome.tick).toBe(tape.virtualTicks);
      expect(outcome.state, "the ending state Node recorded").toEqual(tape.finalState);
    } else {
      // The same opening played in Node, with the tape's seed and random source.
      const node = new Speedrun(route.hash, tape.seed, { rngVersion: 2 });
      node.replay(actions);
      expect(outcome.tick).toBe(node.ticks);
      expect(outcome.state, "the state Node reaches at the same progress entry").toEqual(
        node.engine.readState(),
      );
    }
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
    await page.screenshot({ path: test.info().outputPath(`${route.alias}-milestone.png`) });
  });
}
