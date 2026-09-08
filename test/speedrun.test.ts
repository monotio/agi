import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSkip } from "./fixtures.ts";
import { Speedrun, randomSource } from "./speedrun/runner.ts";

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
