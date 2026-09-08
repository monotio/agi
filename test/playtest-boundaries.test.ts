import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState } from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import { openContainer } from "../src/container/container.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
import { validateVarAssertion } from "../src/agent/gameTestSteps.ts";

function world(caption = false) {
  const state = createAgentSessionState();
  state.container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  state.container.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  for (const [num, source] of [
    [0, "if(equaln(v0,0)){new.room(1);}call(1);return;"],
    [
      1,
      `if(isset(f5)){configure.screen(0,23,24);load.pic(v0);draw.pic(v0);show.pic();load.view(0);animate.obj(o0);set.view(o0,0);position(o0,${caption ? "40,100" : "80,120"});${caption ? 'display(12,10,"B");' : ""}draw(o0);accept.input();}return;`,
    ],
  ] as const)
    state.container.putResource(
      "logic",
      num,
      assembleLogic(source, { dictionary: new Map() }).payload,
    );
  const engine = new Engine(openContainer(state.getFiles()), {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  engine.tick();
  return { state, engine };
}

test("walkTo accepts the final permitted tick, but rejects a target one tick farther", () => {
  const { state, engine } = world();
  for (const [x, success] of [
    [80, true],
    [81, true],
    [82, false],
  ] as const) {
    const result = playtestRoom(
      state,
      { room: 1, steps: [{ action: "walkTo", x, y: 120, ticks: 1 }] },
      { setupImage: engine.serialize() },
    );
    assert.equal(result.success, success, result.error ?? "unexpected playtest result");
  }
});

test("reachable accepts arrival on the last available cycle", () => {
  const { state, engine } = world();
  for (const [x, success] of [
    [80, true],
    [81, true],
    [82, false],
  ] as const) {
    const result = playtestRoom(
      state,
      { room: 1, steps: [], cycleBudget: 1, expect: { reachable: { x, y: 120 } } },
      { setupImage: engine.serialize() },
    );
    assert.equal(result.success, success, result.error ?? "unexpected playtest result");
  }
});

test("visible text assertions reject captions occluded in the presented surface", () => {
  const { state, engine } = world(true);
  assert.match(engine.textRow(12), /B/);
  assert.equal(engine.textCells[(12 * 40 + 10) * 2], 0);
  const result = playtestRoom(state, { room: 1, steps: [], expect: { text: "B" } });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Expected visible text/);
});

test("variable assertions reject mixed exact values and ranges", () => {
  for (const range of [{ min: 100 }, { max: 110 }, { min: 100, max: 110 }])
    assert.throws(
      () => validateVarAssertion({ id: 40, value: 2, ...range }, "variable"),
      /exact value or.*range/,
    );
  assert.deepEqual(validateVarAssertion({ id: 40, value: 2 }, "variable"), {
    id: 40,
    value: 2,
    min: null,
    max: null,
  });
});
