/** Released History executes under its writer's rules, across every 1.2.6 lifecycle change. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeKeys: () => [],
  takeInputLine: () => null,
  waitKey() {
    throw new HostWait();
  },
};
function game(source: string, profile: ProfileId, replayBehavior: Engine["replayBehavior"]) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { profile: PROFILES[profile], dictionary: new Map() }).payload,
  );
  return new Engine(container, host, undefined, { profile, replayBehavior });
}
for (const profile of ["2.001", "2.089", "2.230", "2.272"] as const) {
  test(`${profile}: released persistent print continues and timed print retains v21`, () => {
    const persistent = game(
      'set(f15);print("Kept window");assignn(v200,42);return;',
      profile,
      "1.2.5",
    );
    persistent.tick();
    assert.equal(persistent.vars[200], 42);
    assert.equal(persistent.flags[15], 1);
    assert.ok(
      Array.from({ length: 25 }, (_, row) => persistent.textRow(row))
        .join(" ")
        .includes("Kept window"),
    );
    const timed = game('assignn(v21,1);print("Timed");assignn(v200,42);return;', profile, "1.2.5");
    timed.tick();
    timed.advanceClock(500);
    timed.tick();
    assert.equal(timed.vars[200], 42);
    assert.equal(timed.vars[21], 1);
  });
}
for (const action of ["restart.game()", "quit(0)"] as const) {
  test(`released ${action} waits for an answer despite f15 and v21`, () => {
    const engine = game(
      `if(isset(f6)){return;}set(f15);assignn(v21,1);${action};return;`,
      "2.936",
      "1.2.5",
    );
    engine.tick();
    assert.equal(engine.modalKind, "print");
    engine.advanceClock(5_000);
    assert.equal(engine.modalKind, "print");
    assert.equal(engine.flags[15], 1);
    assert.equal(engine.vars[21], 1);
    engine.deliverHostAnswer(27);
    engine.tick();
    assert.equal(engine.flags[6], 0, "Esc continues the recorded game");
    assert.equal(engine.vars[21], 1, "cancellation retains the recorded timer");
  });
}
test("released restore clears the echo and gate bytes and keeps disabled menu items", () => {
  const engine = game(
    'set.menu("Game");set.menu.item("Look",1);submit.menu();disable.item(1);return;',
    "3.002.086",
    "1.2.5",
  );
  engine.tick();
  const image = engine.serialize();
  const replay = engine.captureReplayState(true);
  engine.restoreReplayState({ ...replay, acceptedLine: "echo", menuGate: 19, releaseGate: 17 });
  engine.restoreImage(image);
  const restored = engine.captureReplayState(true);
  assert.equal(restored.acceptedLine, "");
  assert.equal(restored.menuGate, 0);
  assert.equal(restored.releaseGate, 0);
  assert.equal(engine.readMenuState().headings[0]!.items[0]!.enabled, false);
  assert.equal(engine.autosaveImage(), null, "the released restore did not mark a picture shown");
});
test("released restart resets script capacity, menu and screen", () => {
  const engine = game(
    'if(isset(f6)){return;}set.menu("Game");set.menu.item("Look",1);submit.menu();script.size(90);status.line.on();display(8,0,"KEPT");set(f16);restart.game();return;',
    "2.936",
    "1.2.5",
  );
  engine.tick();
  const saved = decodeSave(engine.serialize(), engine.profile);
  assert.equal(saved.replayCapacity, 50);
  assert.equal(saved.statusEnabled, 0);
  assert.equal(engine.readMenuState().headings.length, 0);
  assert.ok(!engine.textRow(8).includes("KEPT"));
});
