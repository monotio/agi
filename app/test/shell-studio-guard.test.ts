import assert from "node:assert/strict";
import { test } from "node:test";
import { reactive } from "vue";
import type { EngineApi } from "../src/engineContext.ts";
import type { ShellBridge } from "../src/shellBridge.ts";
import { createShell } from "../src/shell/useShell.ts";

/** A running game in Create, and a Studio guard whose answer the test sets. */
function setup() {
  const state = reactive({
    phase: "running",
    walkthrough: { active: false },
    historyView: { active: false },
    patchTick: 0,
  });
  const guard = {
    unkept: true,
    answer: true,
    asked: 0,
  };
  const shell = createShell({
    engine: { state, currentGame: () => null } as unknown as Pick<
      EngineApi,
      "state" | "currentGame"
    >,
    bridge: {} as ShellBridge,
    librarySource: () => undefined,
    initialMode: "create",
    createGuard: {
      unkept: () => guard.unkept,
      confirm: () => {
        guard.asked++;
        // Keep and Discard both leave nothing unkept.
        if (guard.answer) guard.unkept = false;
        return Promise.resolve(guard.answer);
      },
    },
  });
  return { shell, guard, state };
}

test("switching to Play settles unkept Studio changes first: Cancel stays in Create", async () => {
  const { shell, guard } = setup();
  guard.answer = false;
  shell.setMode("play");
  assert.equal(shell.mode.value, "create", "nothing changes until the question is answered");
  await Promise.resolve();
  assert.equal(shell.mode.value, "create");
  assert.equal(guard.asked, 1);
  guard.answer = true;
  shell.setMode("play");
  await Promise.resolve();
  assert.equal(shell.mode.value, "play");
  // Back in Create with nothing unkept, leaving asks nothing.
  shell.setMode("create");
  shell.setMode("play");
  assert.equal(shell.mode.value, "play");
  assert.equal(guard.asked, 2);
});

test("Back or Forward to Play asks too, and a game that stopped meanwhile stays put", async () => {
  const { shell, guard, state } = setup();
  guard.answer = false;
  shell.followRoute("#play/demo");
  await Promise.resolve();
  assert.equal(shell.mode.value, "create");
  guard.answer = true;
  guard.unkept = true;
  shell.followRoute("#play/demo");
  await Promise.resolve();
  assert.equal(shell.mode.value, "play");
  shell.followRoute("#create/demo");
  guard.unkept = true;
  guard.answer = true;
  shell.followRoute("#play/demo");
  state.phase = "idle";
  await Promise.resolve();
  assert.equal(shell.mode.value, "create", "no game runs to show in Play");
});
