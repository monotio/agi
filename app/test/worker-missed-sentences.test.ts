import assert from "node:assert/strict";
import { test } from "node:test";
import { workerHarness, gameContainer } from "./worker-ctx.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { newProjectAdmissionState } from "../src/worker/projectAdmissionState.ts";
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
