import assert from "node:assert/strict";
import { test } from "node:test";
import { workerHarness, gameContainer } from "./worker-ctx.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { newProjectAdmissionState } from "../src/worker/projectAdmissionState.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { createEngineHost } from "../src/worker/host.ts";

test("Create observes unknown and unanswered input once, including a cleared matched latch", () => {
  const { ctx, control } = workerHarness(
    gameContainer(["accept.input(); if (said(100)) { reset(f4); reset(f2); } return;"]),
  );
  ctx.engine = new Engine(
    gameContainer(["accept.input(); if (said(100)) { reset(f4); reset(f2); } return;"]),
    createEngineHost(ctx),
    new Map([
      ["look", 100],
      ["tree", 120],
    ]),
  );
  ctx.input.observeSentences = true;
  ctx.projectAdmission = newProjectAdmissionState("test", ctx.engine);
  ctx.fns.tickEngine();
  for (const text of ["look", "look tree", "missing tree"]) {
    ctx.fns.onInput({ type: "input", text });
    ctx.fns.tickEngine();
    ctx.fns.tickEngine();
  }
  assert.deepEqual(
    control.filter((m) => m.type === "missedSentence").map((m) => [m.text, m.room, m.unknown]),
    [
      ["look tree", 0, ""],
      ["missing tree", 0, "missing"],
    ],
  );
  ctx.projectAdmission = null;
  ctx.fns.onInput({ type: "input", text: "other" });
  ctx.fns.tickEngine();
  assert.equal(control.filter((m) => m.type === "missedSentence").length, 2);
});

test("setting f4 directly does not invent a said match; prompted parses keep the original observation", () => {
  const { ctx, control } = workerHarness(
    gameContainer([
      'accept.input(); set(f4); set.string(s0,"other"); parse(s0); reset(f2); return;',
    ]),
  );
  ctx.engine = new Engine(
    gameContainer([
      'accept.input(); set(f4); set.string(s0,"other"); parse(s0); reset(f2); return;',
    ]),
    createEngineHost(ctx),
    new Map([["look", 100]]),
  );
  ctx.input.observeSentences = true;
  ctx.projectAdmission = newProjectAdmissionState("test", ctx.engine);
  ctx.fns.tickEngine();
  ctx.fns.onInput({ type: "input", text: "look" });
  ctx.fns.tickEngine();
  assert.deepEqual(
    control.filter((m) => m.type === "missedSentence").map((m) => [m.text, m.unknown]),
    [["look", ""]],
  );
});

test("a LOGIC parse starts another input; its said match cannot resolve the player's earlier miss", () => {
  const container = gameContainer([
    'accept.input(); set.string(s0,"other"); parse(s0); if (said(120)) { assignn(v40,1); } return;',
  ]);
  const { ctx, control } = workerHarness(container);
  ctx.engine = new Engine(
    container,
    createEngineHost(ctx),
    new Map([
      ["look", 100],
      ["other", 120],
    ]),
  );
  ctx.input.observeSentences = true;
  ctx.projectAdmission = newProjectAdmissionState("test", ctx.engine);
  ctx.fns.tickEngine();
  ctx.fns.onInput({ type: "input", text: "look" });
  ctx.fns.tickEngine();
  assert.equal(ctx.engine.vars[40], 1);
  assert.deepEqual(
    control.filter((m) => m.type === "missedSentence").map((m) => [m.text, m.unknown]),
    [["look", ""]],
  );
});

for (const stop of ["breakpoint", "watch", "input watch"] as const) {
  test(`sentence observation waits for said after a ${stop} and reports a resumed miss once`, () => {
    const source = "accept.input();\n increment(v40);\n if (said(100)) { assignn(v41,1); } return;";
    const container = gameContainer([source]);
    const { ctx, control } = workerHarness(container);
    ctx.engine = new Engine(
      container,
      createEngineHost(ctx),
      new Map([
        ["look", 100],
        ["tree", 120],
      ]),
    );
    ctx.input.observeSentences = true;
    ctx.projectAdmission = newProjectAdmissionState("test", ctx.engine);
    ctx.fns.tickEngine();
    onWorkerMessage(ctx, { type: "debugAttach", id: 1, sources: { "0": source } });
    const epoch = ctx.debugger.epoch;
    let revision = 0;
    for (const text of ["look", "tree"]) {
      onWorkerMessage(ctx, {
        type: "debugConfigure",
        id: 2,
        epoch,
        revision: ++revision,
        ...(stop === "breakpoint"
          ? {
              breakpoints: [
                { id: "before-said", enabled: true, logic: 0, line: 3, mode: "statement" as const },
              ],
            }
          : {
              watchpoints: [
                {
                  id: "before-said",
                  enabled: true,
                  target:
                    stop === "input watch"
                      ? { kind: "flag" as const, index: 2 }
                      : { kind: "variable" as const, index: 40 },
                },
              ],
            }),
      });
      onWorkerMessage(ctx, { type: "input", text });
      ctx.fns.stepHostTick(10, { cycle: true, sound: 0 });
      const stopped = control.findLast((m) => m.type === "debugStopped");
      assert.ok(stopped?.type === "debugStopped");
      assert.equal(stopped.reasons[0]!.kind, stop === "breakpoint" ? "breakpoint" : "watch");
      if (stop === "input watch") assert.equal(ctx.engine.continuationPending, false);
      assert.deepEqual(
        control.filter((m) => m.type === "missedSentence"),
        [],
      );
      onWorkerMessage(ctx, {
        type: "debugConfigure",
        id: 4,
        epoch,
        revision: ++revision,
        breakpoints: [],
        watchpoints: [],
      });
      onWorkerMessage(ctx, {
        type: "debugResume",
        id: 3,
        epoch,
        stopId: stopped.stopId,
        action: "continue",
      });
      assert.equal(ctx.engine.vars[41], 1);
    }
    assert.deepEqual(
      control.filter((m) => m.type === "missedSentence").map((m) => m.text),
      ["tree"],
    );
    ctx.fns.stepHostTick(20, { cycle: true, sound: 0 });
    assert.equal(control.filter((m) => m.type === "missedSentence").length, 1);
  });
}
