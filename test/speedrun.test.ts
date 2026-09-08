import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSkip } from "./fixtures.ts";
import { Speedrun, randomSource } from "./speedrun/runner.ts";
import { kq2Opening } from "./speedrun/kq2-opening.ts";
import { sq1Opening } from "./speedrun/sq1-opening.ts";

test("speedrun randomness has a stable seed contract", () => {
  const next = randomSource(1);
  assert.deepEqual(Array.from({ length: 4 }, next), [15496, 24200, 33046, 46195]);
});

test(
  "KQ1 speedrun builds death diagnostics only when Graham dies",
  { skip: fixtureSkip("kq1", ["AGIDATA.OVL"]) },
  (t) => {
    const run = new Speedrun();
    const state = t.mock.method(run, "state");
    run.advance(30);
    assert.equal(state.mock.callCount(), 0, "successful ticks need no diagnostic snapshots");
    run.engine.flags[63] = 1;
    assert.throws(() => run.advance(), /Graham died: .*"room":83/);
    assert.equal(state.mock.callCount(), 1, "a death still includes its diagnostic snapshot");
  },
);

test(
  "KQ1 speedrun cold boots using inputs and rejects a false progress claim",
  {
    skip: fixtureSkip("kq1", ["AGIDATA.OVL"]),
  },
  () => {
    const run = new Speedrun();
    run.advance(30);
    assert.equal(run.state().room, 83);
    run.key(13);
    run.advance(30);
    run.dismiss();
    run.checkpoint("Start", { room: 1, score: 0 });
    assert.equal(run.engine.profile.id, "2.917");
    assert.throws(() => run.checkpoint("False victory", { score: 159 }), /False victory/);
    assert.ok(run.ticks >= 60);
    assert.deepEqual(run.actions.slice(0, 3), [
      { kind: "advance", ticks: 30 },
      { kind: "key", code: 13 },
      { kind: "advance", ticks: 30 },
    ]);
  },
);

for (const scenario of [
  { slug: "kq2", profile: "2.411", route: kq2Opening, label: "basket, earrings, cloak and ring" },
  { slug: "sq1", profile: "2.917", route: sq1Opening, label: "cartridge and keycard" },
]) {
  test(
    `${scenario.slug} opening walkthrough reaches ${scenario.label} from a cold boot`,
    { skip: fixtureSkip(scenario.slug, ["AGIDATA.OVL"]) },
    () => {
      const first = new Speedrun(scenario.slug, 1);
      assert.equal(first.engine.profile.id, scenario.profile);
      scenario.route(first);
      const replay = new Speedrun(scenario.slug, 1);
      scenario.route(replay);
      assert.deepEqual(replay.actions, first.actions, "the seed-1 route is reproducible");
    },
  );
}
