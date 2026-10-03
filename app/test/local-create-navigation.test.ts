import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, reactive } from "vue";
import { requireProjectId, type ProjectId } from "../../src/gameIdentity.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";
import type { ShellBridge } from "../src/shell/shellBridge.ts";
import { createShell } from "../src/shell/useShell.ts";

/**
 * The local create flow's race: `bootAuthoredGame` resolves while the phase
 * is still "loading", so `setMode("create")` is refused and the intent is
 * lost — the panel that asked unmounts with Home before the game runs.
 * `expectCreate` holds the switch inside the shell until the named project
 * is the running game.
 */

/** The shell's only DOM surface: the game route it reads and writes. */
const route = { hash: "" };
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: {
    get hash() {
      return route.hash;
    },
  },
});
Object.defineProperty(globalThis, "history", {
  configurable: true,
  value: {
    pushState: (_state: unknown, _unused: string, target: string) => {
      route.hash = target;
    },
    replaceState: (_state: unknown, _unused: string, target: string) => {
      route.hash = target;
    },
  },
});

/** A shell over a fake engine whose phase and booted game the test drives. */
function setup() {
  route.hash = "";
  const state = reactive({
    phase: "idle" as "idle" | "loading" | "running" | "error",
    walkthrough: { active: false },
    historyView: { active: false },
    patchTick: 0,
  });
  let game: { installed: boolean; projectId: ProjectId } | null = null;
  const shell = createShell({
    engine: { state, currentGame: () => game } as unknown as Pick<
      EngineApi,
      "state" | "currentGame"
    >,
    bridge: {} as ShellBridge,
    librarySource: () => undefined,
  });
  return {
    shell,
    state,
    /** A boot's middle: the game is already in the slot, still loading. */
    loading: (id: ProjectId) => {
      game = { installed: false, projectId: id };
      state.phase = "loading";
    },
  };
}

test("a Create switch queued during boot lands when that project runs", async () => {
  const id = requireProjectId("local-queued");
  const { shell, state, loading } = setup();
  loading(id);
  shell.expectCreate(id);
  await nextTick();
  assert.equal(shell.mode.value, "play", "Create waits out the loading phase");
  state.phase = "running";
  await nextTick();
  assert.equal(shell.mode.value, "create");
  assert.equal(route.hash, "#create/local-queued");
});

test("the queued switch still lands when the game reached running first", async () => {
  const id = requireProjectId("local-fast");
  const { shell, state, loading } = setup();
  loading(id);
  state.phase = "running";
  await nextTick();
  shell.expectCreate(id);
  assert.equal(shell.mode.value, "create");
});

test("a failed boot drops the queued switch; the next boot opens in Play", async () => {
  const id = requireProjectId("local-failed");
  const { shell, state, loading } = setup();
  loading(id);
  shell.expectCreate(id);
  state.phase = "error";
  await nextTick();
  assert.equal(shell.mode.value, "play");
  loading(id);
  await nextTick();
  state.phase = "running";
  await nextTick();
  assert.equal(shell.mode.value, "play", "the spent intent is not parked for later boots");
});

test("a replacement boot does not inherit the queued switch", async () => {
  const wanted = requireProjectId("local-wanted");
  const other = requireProjectId("local-other");
  const { shell, state, loading } = setup();
  loading(wanted);
  shell.expectCreate(wanted);
  loading(other);
  await nextTick();
  state.phase = "running";
  await nextTick();
  assert.equal(shell.mode.value, "play");
  assert.equal(route.hash, "", "no Create route is written for the other game");
  loading(wanted);
  await nextTick();
  state.phase = "running";
  await nextTick();
  assert.equal(shell.mode.value, "play");
});

test("leaving the game clears a queued switch", async () => {
  const id = requireProjectId("local-left");
  const { shell, state, loading } = setup();
  loading(id);
  shell.expectCreate(id);
  shell.reset();
  state.phase = "running";
  await nextTick();
  assert.equal(shell.mode.value, "play");
});

test("a queued switch with no boot behind it does not wait at the menu", async () => {
  const id = requireProjectId("local-idle");
  const { shell, state, loading } = setup();
  shell.expectCreate(id);
  loading(id);
  await nextTick();
  state.phase = "running";
  await nextTick();
  assert.equal(shell.mode.value, "play");
});
