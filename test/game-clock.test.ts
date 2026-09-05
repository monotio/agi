import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine } from "../src/runtime/engine.ts";

function clockGame(source = "return;") {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeKeys: () => [],
    takeInputLine: () => null,
  });
}

test("the game clock counts elapsed seconds independently of logic speed and rolls into days", () => {
  const engine = clockGame();
  for (let i = 0; i < 100; i++) engine.tick();
  assert.equal(engine.vars[11], 0);
  engine.advanceClock(999);
  assert.equal(engine.vars[11], 0);
  engine.advanceClock(1);
  assert.equal(engine.vars[11], 1);
  engine.vars.set([59, 59, 23, 255], 11);
  engine.advanceClock(1000);
  assert.deepEqual(Array.from(engine.vars.slice(11, 15)), [0, 0, 0, 0]);
  for (let i = 0; i < 60; i++) engine.advanceClock(1000 / 60);
  assert.equal(engine.vars[11], 1);
  engine.vars[11] = 20;
  engine.advanceClock(1000);
  assert.equal(engine.vars[11], 21, "the game's clock assignments remain authoritative");
});

test("clock values survive restore and timed logic finishes without depending on animation cycles", () => {
  const engine = clockGame(`
    if(!isset(f200)){set(f200);assignn(v50,3);}
    if(!equalv(v11,v51)){assignv(v51,v11);decrement(v50);}
    if(equaln(v50,0)){set(f60);}return;
  `);
  engine.tick();
  engine.advanceClock(1000);
  engine.tick();
  const saved = engine.serialize();
  engine.advanceClock(7000);
  engine.restoreImage(saved);
  assert.equal(engine.vars[11], 1);
  for (let i = 0; i < 1000; i++) engine.tick();
  assert.equal(engine.flags[60], 0);
  engine.advanceClock(1000);
  engine.tick();
  assert.equal(engine.flags[60], 0);
  engine.advanceClock(1000);
  engine.tick();
  assert.equal(engine.flags[60], 1);
});

test("a modal pauses the game clock without losing its fractional second", () => {
  const engine = clockGame('if(!isset(f200)){set(f200);print("Wait.");}return;');
  engine.advanceClock(500);
  engine.tick();
  engine.advanceClock(5000);
  assert.equal(engine.vars[11], 0);
  engine.ackPrint();
  engine.tick();
  engine.advanceClock(500);
  assert.equal(engine.vars[11], 1);
});
