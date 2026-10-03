import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";

function parked(
  source = "increment(v60); if (equaln(v0, 0)) { new.room(5); } if (equaln(v0, 5)) { call(5); } return;",
) {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  let calls = 0;
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
    prepareRoom() {
      calls++;
      throw new HostWait();
    },
    promptNumber() {
      throw new HostWait();
    },
  };
  const engine = new Engine(container, host, new Map());
  engine.setExecutionGate(() => false);
  engine.setExecutionObserver(() => false);
  engine.tick();
  return { engine, container, calls: () => calls };
}

const destination = {
  kind: "logic" as const,
  num: 5,
  payload: assembleLogic("assignn(v101, 7); return;", { dictionary: new Map() }).payload,
};

test("an armed prepareRoom wait accepts its validated room resources before the answer", () => {
  const { engine, container, calls } = parked();
  assert.equal(engine.hostInteraction?.kind, "room");
  assert.equal(engine.executionStopInfo, null);
  engine.patchResources([destination]);
  assert.deepEqual(container.getResource("logic", 5), destination.payload);
  engine.deliverHostAnswer(true);
  engine.tick();
  assert.equal(engine.vars[0], 5);
  assert.equal(engine.vars[101], 7);
  assert.equal(calls(), 1);
  assert.equal(engine.executionControlActive, true);
});

test("the armed prepareRoom boundary also admits the coordinated vocabulary file", () => {
  const { engine, container } = parked();
  const words = buildWordsTok([{ word: "lantern", id: 42 }]);
  engine.patchAuxiliaryFiles({ words });
  assert.deepEqual(container.files.get("WORDS.TOK"), words);
  assert.equal(engine.hostInteraction?.kind, "room");
});

test("a debugger latch over prepareRoom rejects room and metadata mutation", () => {
  const { engine, container } = parked();
  const generation = engine.patchGeneration;
  engine.pauseExecution();
  assert.throws(() => engine.patchResources([destination]), /parked execution/);
  assert.throws(() => engine.patchAuxiliaryFiles({ words: buildWordsTok([]) }), /parked execution/);
  assert.equal(container.getResource("logic", 5), null);
  assert.equal(container.files.get("WORDS.TOK"), undefined);
  assert.equal(engine.patchGeneration, generation);
});

test("other armed host waits and an already delivered room answer keep the mutation guard", () => {
  const number = parked('get.num("Number", v60); return;');
  assert.equal(number.engine.hostInteraction?.kind, "getnum");
  assert.throws(() => number.engine.patchResources([destination]), /parked execution/);
  assert.throws(
    () => number.engine.patchAuxiliaryFiles({ words: buildWordsTok([]) }),
    /parked execution/,
  );
  const room = parked();
  room.engine.deliverHostAnswer(false);
  assert.throws(() => room.engine.patchResources([destination]), /parked execution/);
  assert.throws(
    () => room.engine.patchAuxiliaryFiles({ words: buildWordsTok([]) }),
    /parked execution/,
  );
});
