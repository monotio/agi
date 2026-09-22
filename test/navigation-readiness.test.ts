import assert from "node:assert/strict";
import { test } from "node:test";
import { AGI_KEY, DIRECTION_KEYS } from "../src/runtime/keys.ts";
import type { TraversalRequest } from "../src/agent/navigationTraversal.ts";
import type { Target } from "../src/agent/navigation.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { Speedrun } from "./speedrun/runner.ts";

function boot(game: string, room: number): Speedrun {
  const run = new Speedrun(game, 1);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (run.state().room === room && run.engine.inputEnabled && run.engine.movementControlEnabled)
      return run;
    // Keys queued before the boot's new.room now survive the transition and
    // skip the title a cycle early; press Enter only once a room is showing.
    if (run.state().room !== 0 && run.state().room !== room) run.key(AGI_KEY.ENTER);
    run.advance(30);
  }
  assert.fail("Title did not yield the expected starting room");
}

test(
  "KQ1 tree passage uses one target goal without crossing waypoints",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]) },
  () => {
    const run = boot(KNOWN_GAME_HASH.KQ1, 1);
    run.walkTo(110, 135);
    run.walkTo(100, 150);
    run.exit("W", 2);
    run.walkTo(110, 150);
    run.walkTo(58, 150);
    run.walkTo(45, 137);
    run.walkTo(20, 137);
    run.exit("W", 3);
    run.walkTo(115, 115);
    run.exit("N", 14);
    run.command("climb tree");
    assert.equal(run.state().room, 63);
    const result = run.traverse(
      {
        passage: { kind: "position", planned: true, target: { x0: 67, x1: 69, y0: 96, y1: 98 } },
        passageOptions: { avoidTriggers: true },
        landing: {
          label: "egg branch",
          test: (e) => e.movementControlEnabled && e.screenObjects[0]!.y <= 98,
        },
      },
      { budgets: { hostPolls: 5000, movementUpdates: 250 } },
    );
    assert.equal(result.status, "reached", JSON.stringify(result));
    assert.ok(result.counters.searches <= 3);
    assert.ok(result.counters.replans <= 2);
  },
);

test(
  "KQ2 ladder transition uses one declared passage and verifies player control",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ2, ["AGIDATA.OVL"]) },
  () => {
    const run = boot(KNOWN_GAME_HASH.KQ2, 1);
    run.exit("E", 2);
    run.exit("E", 3);
    run.walkTo(8, 130);
    run.walkTo(134, 130);
    run.walkTo(134, 80);
    run.walkTo(138, 75);
    run.exit("N", 45);
    run.exit("E", 46);
    run.walkTo(102, 135);
    run.command("open door");
    run.waitForRoom(72, "tree door", 1200);
    const result = run.traverse(
      {
        approach: { kind: "position", planned: true, target: { x0: 90, x1: 90, y0: 115, y1: 115 } },
        approachOptions: { avoidTriggers: false, geometry: "current" },
        approachComplete: { label: "ladder mounted", test: (e) => e.flags[31] !== 0 },
        passage: { kind: "exit", direction: 5, room: 73, planned: true },
        passageOptions: { avoidTriggers: true, geometry: "current" },
        landing: {
          label: "lower ladder under player control",
          test: (e) => e.vars[0] === 73 && e.flags[31] !== 0 && e.movementControlEnabled,
        },
      },
      { budgets: { hostPolls: 5000, movementUpdates: 250 } },
    );
    assert.equal(result.status, "reached", JSON.stringify(result));
    assert.ok(result.counters.searches <= 4);
    assert.ok(result.counters.replans <= 2);
  },
);

test(
  "KQ3 staircase activates its crossing state and avoids only the known harmful trigger",
  { skip: fixtureSkip(KNOWN_GAME_HASH.KQ3, ["AGIDATA.OVL"]) },
  () => {
    const run = boot(KNOWN_GAME_HASH.KQ3, 7);
    // LOGIC 105's first appearance assigns a chore before releasing control.
    for (let tick = 0; tick < 3000; tick++) {
      if (run.engine.modalKind !== null) {
        assert.match(run.messages.at(-1) ?? "", /kitchen is filthy/);
        run.key(AGI_KEY.ENTER);
      }
      if (
        run.engine.flags[129] !== 0 &&
        run.engine.flags[99] === 0 &&
        run.engine.movementControlEnabled
      )
        break;
      run.advance();
    }
    assert.equal(run.engine.flags[129], 1);
    assert.equal(run.engine.flags[99], 0);
    // LOGIC 7 permits control-1 crossings when f221 is set by a southward step
    // from control-3. It rejects control-2 contacts only in this position box;
    // the control-2 strip at the upstairs exit remains a required trigger.
    const avoidRegions: Target[] = [{ x0: 0, x1: 50, y0: 99, y1: 99 }];
    const width = run.engine.screenObjects[0]!.width;
    for (let y = 87; y <= 107; y++) {
      let start: number | null = null;
      for (let x = 45; x <= 63; x++) {
        let harmful = false;
        if (x <= 62)
          for (let dx = 0; dx < width; dx++)
            if (run.engine.surface.priority[y * 160 + x + dx] === 2) harmful = true;
        if (harmful && start === null) start = x;
        if (!harmful && start !== null) {
          avoidRegions.push({ x0: start, x1: x - 1, y0: y, y1: y });
          start = null;
        }
      }
    }
    const request: TraversalRequest = {
      approach: { kind: "position", planned: true, target: { x0: 35, x1: 42, y0: 99, y1: 99 } },
      approachOptions: { avoidTriggers: false },
      activation: {
        keys: [DIRECTION_KEYS[5]!],
        ready: { label: "water-marked stair landing", test: (e) => e.flags[0] !== 0 },
        changed: {
          label: "crossing mode enabled outside water",
          test: (e) => e.flags[221] !== 0 && e.flags[0] === 0,
        },
      },
      passage: { kind: "position", planned: true, target: { x0: 93, x1: 109, y0: 42, y1: 44 } },
      expectedRoom: 3,
      passageOptions: {
        avoidTriggers: false,
        geometry: "current",
        avoidRegions,
        maxSearchNodes: 241920,
      },
      landing: {
        label: "upper hallway under player control",
        test: (e) => e.vars[0] === 3 && e.movementControlEnabled,
      },
    };
    const before = run.engine.serialize();
    const attempts = run.probe(
      [
        {
          label: "upstairs",
          run: (branch) =>
            branch.traverse(request, {
              budgets: { hostPolls: 5000, logicCycles: 1000, movementUpdates: 250 },
              maxSearches: 4,
            }),
        },
      ],
      { maxCandidates: 1, maxTicksPerCandidate: 5000, maxTotalTicks: 5000 },
    );
    assert.equal(
      attempts.candidates[0]!.status,
      "completed",
      attempts.candidates[0]!.error ?? "stair probe",
    );
    assert.equal(attempts.prefixTicksReused, run.ticks);
    assert.deepEqual(
      run.engine.serialize(),
      before,
      "candidate leaves its retained boundary unchanged",
    );
    const selected = attempts.candidates[0]!;
    const result = selected.value!;
    assert.equal(result.status, "reached", JSON.stringify(result));
    assert.equal(result.counters.activationInputs, 1);
    assert.ok(result.counters.searches <= 4);
    assert.ok(result.counters.replans <= 2);
    assert.ok(result.counters.movementUpdates <= 200);
    assert.ok(attempts.hostPolls <= 1200);
    const replay = new Speedrun(KNOWN_GAME_HASH.KQ3, 1);
    for (const action of selected.branch.actions) {
      if (action.kind === "key") replay.key(action.code);
      else if (action.kind === "advance") replay.advance(action.ticks);
      else assert.fail("This staircase proof uses ordinary key and advance actions only");
    }
    assert.deepEqual(
      replay.engine.serialize(),
      selected.branch.engine.serialize(),
      "selected candidate retains an exact cold-boot input proof",
    );
  },
);
