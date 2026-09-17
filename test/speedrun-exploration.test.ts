import assert from "node:assert/strict";
import { test } from "node:test";
import { AGI_KEY } from "../src/runtime/keys.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { loadGame } from "./game-fixture.ts";
import { Speedrun, type Action } from "./speedrun/runner.ts";

function randomGame() {
  const fixture = loadGame("synthetic");
  fixture.container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); }
       call.v(v0); random(0, 255, v50); return;`,
      { dictionary: fixture.dict },
    ).payload,
  );
  return fixture;
}

function compareRuns(actual: Speedrun, expected: Speedrun): void {
  assert.deepEqual(actual.state(), expected.state());
  assert.equal(actual.ticks, expected.ticks);
  assert.equal(actual.cycles, expected.cycles);
  assert.deepEqual(actual.engine.captureReplayState(), expected.engine.captureReplayState());
  assert.deepEqual(actual.engine.recordingImage(), expected.engine.recordingImage());
}

function replay(run: Speedrun, actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.kind === "key") run.key(action.code);
    else if (action.kind === "advance") run.advance(action.ticks);
    else throw new Error("This proof records only player keys and host polls.");
  }
}

test("fork preserves RNG, queued keys and fractional clock without replaying its prefix", () => {
  const source = new Speedrun("synthetic", 1, { fixture: randomGame() });
  source.advance(19);
  source.key(AGI_KEY.RIGHT);
  const prefix = structuredClone(source.actions);
  const branch = source.fork();
  compareRuns(branch, source);
  branch.advance(31);
  assert.deepEqual(source.actions, prefix, "merging advances on a branch cannot edit the prefix");
  assert.equal(source.ticks, 19);
  source.advance(31);
  compareRuns(branch, source);
  const cold = new Speedrun("synthetic", 1, { fixture: randomGame() });
  replay(cold, branch.actions);
  compareRuns(cold, branch);
});

test("fork preserves parked print and the elapsed interval since the last scheduler poll", () => {
  const source = new Speedrun("synthetic");
  source.advance(19);
  for (const character of "look") source.key(character.charCodeAt(0));
  source.key(AGI_KEY.ENTER);
  source.until(() => source.engine.modalKind === "print", 40, "print opens");
  source.advance(17);
  const branch = source.fork();
  compareRuns(branch, source);
  branch.key(AGI_KEY.ENTER);
  source.key(AGI_KEY.ENTER);
  for (let poll = 0; poll < 20; poll++) {
    branch.advance();
    source.advance();
    compareRuns(branch, source);
  }
});

test("a paused walkthrough fork preserves pacing without accumulating the pause interval", () => {
  const fixture = loadGame("synthetic");
  fixture.container.putResource(
    "logic",
    0,
    assembleLogic(
      "if (!isset(f200)) {set(f200); assignn(v0,1); assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); assignn(v10,2); pause();} increment(v51); return;",
      { dictionary: fixture.dict },
    ).payload,
  );
  const source = new Speedrun("synthetic", 1, { fixture });
  source.advance(6);
  assert.equal(source.engine.timerPaused, true);
  source.advance(60);
  const branch = source.fork();
  for (const run of [source, branch]) {
    run.key(AGI_KEY.ENTER);
    run.advance(1);
    assert.equal(run.engine.vars[51], 1, "acknowledgement resumes the parked pass");
    run.advance(1);
    assert.equal(run.engine.vars[51], 1, "the pause must not create a due cycle");
    run.advance(5);
    assert.equal(run.engine.vars[51], 2, "the next complete pacing interval runs once");
  }
  compareRuns(branch, source);
});

test("walkthrough forks retain ordinary wait pacing through a following pause", () => {
  const fixture = loadGame("synthetic");
  fixture.container.putResource(
    "logic",
    0,
    assembleLogic(
      'if (!isset(f200)) {set(f200); assignn(v0,1); assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); assignn(v10,4); print("Wait."); pause();} increment(v51); return;',
      { dictionary: fixture.dict },
    ).payload,
  );
  const source = new Speedrun("synthetic", 1, { fixture });
  source.advance(66);
  source.key(AGI_KEY.ENTER);
  source.advance();
  assert.equal(source.engine.timerPaused, true);
  source.advance(60);
  const branch = source.fork();
  for (const run of [source, branch]) {
    run.key(AGI_KEY.ENTER);
    run.advance();
    assert.equal(run.engine.vars[51], 1);
    run.advance();
    assert.equal(run.engine.vars[51], 2, "ordinary wait pacing survived pause and fork");
  }
  compareRuns(branch, source);
});

test("fork keeps explicit prompt answers and container bytes independent", () => {
  const fixture = randomGame();
  const source = new Speedrun("synthetic", 1, { fixture });
  source.advance(20);
  source.command("east");
  source.answerNumber(42);
  const branch = source.fork();
  fixture.container.putResource(
    "logic",
    2,
    assembleLogic("assignn(v60, 99); return;", { dictionary: fixture.dict }).payload,
  );
  branch.command("west");
  branch.command("east");
  branch.command("answer");
  assert.equal(branch.engine.vars[60], 42);
  assert.equal(branch.engine.flags[32], 1);
  assert.equal(source.engine.vars[60], 0);
  assert.equal(source.numPrompts.length, 0);
});

test("fork refuses a boundary with no resumable room image", () => {
  const source = new Speedrun("synthetic");
  assert.throws(() => source.fork(), /resumable/);
});

test("probe budgets candidate simulations and reuses the same prefix independently", () => {
  const source = new Speedrun("synthetic");
  source.advance(19);
  const before = structuredClone(source.actions);
  const result = source.probe(
    [
      {
        label: "short",
        run: (branch) => {
          branch.advance(3);
        },
      },
      {
        label: "too long",
        run: (branch) => {
          branch.advance(8);
        },
      },
      {
        label: "remaining",
        run: (branch) => {
          branch.advance(2);
        },
      },
    ],
    { maxCandidates: 3, maxTicksPerCandidate: 5, maxTotalTicks: 5 },
  );
  assert.equal(result.hostPolls, 5);
  assert.equal(result.prefixTicksReused, 57);
  assert.deepEqual(
    result.candidates.map(({ label, status, hostPolls }) => ({ label, status, hostPolls })),
    [
      { label: "short", status: "completed", hostPolls: 3 },
      { label: "too long", status: "budget_exhausted", hostPolls: 0 },
      { label: "remaining", status: "completed", hostPolls: 2 },
    ],
  );
  assert.deepEqual(source.actions, before);
  assert.equal(source.ticks, 19);
  assert.throws(() => source.probe([{ label: "a", run() {} }], { maxCandidates: 0 }), /candidate/);
});

test("fork preserves queued text answers and their recording", () => {
  const fixture = loadGame("synthetic");
  fixture.container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    #message 1 "Name?"
    if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); }
    call.v(v0);
    if (said("test")) { get.string(s1, 1, 23, 0, 10); }
    return;
  `,
      { dictionary: fixture.dict },
    ).payload,
  );
  const source = new Speedrun("synthetic", 1, { fixture });
  source.advance(19);
  source.answer("a code");
  const branch = source.fork();
  branch.command("test");
  assert.equal(branch.engine.strings[1], "a code");
  assert.deepEqual(
    branch.actions.filter((action) => action.kind === "answer"),
    [{ kind: "answer", text: "a code" }],
  );
  assert.equal(source.textPrompts.length, 0);
  source.command("test");
  compareRuns(branch, source);
});

test("fork retains a queued navigation stop before a new heading", () => {
  const source = new Speedrun("synthetic");
  source.advance(19);
  const target = { x0: 24, x1: 24, y0: 130, y1: 130 };
  assert.equal(source.navigate({ kind: "position", target }).outcome.status, "reached");
  assert.equal(source.engine.vars[6], 3, "stop is queued but not yet consumed");
  const branch = source.fork();
  source.direction("E");
  branch.direction("E");
  source.advance(12);
  branch.advance(12);
  compareRuns(branch, source);
  assert.ok(branch.state().x > 24, "the new east heading must survive the queued stop");
});

test("probe explicitly reports candidates omitted by its aggregate poll budget", () => {
  const source = new Speedrun("synthetic");
  source.advance(19);
  const result = source.probe(
    [
      { label: "first", run: (branch) => branch.advance(2) },
      { label: "second", run: (branch) => branch.advance(1) },
    ],
    { maxTotalTicks: 2 },
  );
  assert.equal(result.unattempted, 1);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0]!.wallMs >= 0);
});

test("fork refuses an open menu whose boundary has no parked continuation", () => {
  const fixture = loadGame("synthetic");
  fixture.container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    #message 1 "Game"
    #message 2 "Item"
    if (!isset(f200)) {
      set(f200); set(f14); set.menu(1); set.menu.item(2, 1); submit.menu();
      assignn(v0, 1); new.room.v(v0);
    }
    call.v(v0);
    if (said("help")) { menu.input(); }
    return;
  `,
      { dictionary: fixture.dict },
    ).payload,
  );
  const source = new Speedrun("synthetic", 1, { fixture });
  source.advance(19);
  for (const character of "help") source.key(character.charCodeAt(0));
  source.key(AGI_KEY.ENTER);
  source.until(() => source.engine.modalKind === "menu", 30, "menu opens");
  assert.throws(() => source.fork(), /resumable/);
});

test("traversal adapter records ordinary keys through a declared room landing", () => {
  const source = new Speedrun("synthetic");
  source.advance(19);
  const outcome = source.traverse(
    {
      passage: { kind: "position", target: { x0: 150, x1: 154, y0: 130, y1: 130 }, planned: true },
      expectedRoom: 2,
      landing: {
        label: "Room 2 control",
        test: (engine) => engine.vars[0] === 2 && engine.movementControlEnabled,
      },
    },
    { budgets: { hostPolls: 2000, movementUpdates: 200 } },
  );
  assert.equal(outcome.status, "reached");
  assert.equal(outcome.room, 2);
  assert.equal(outcome.counters.searches, 1);
  const cold = new Speedrun("synthetic");
  replay(cold, source.actions);
  compareRuns(cold, source);
});
