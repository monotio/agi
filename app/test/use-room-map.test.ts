import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, reactive } from "vue";
import { useRoomMap } from "../src/useRoomMap.ts";
import type { EngineState, TextHook } from "../src/useEngineTypes.ts";
import type { BootedGame, Frame } from "../src/gameTypes.ts";
import type { RoomTransitionNotice } from "../src/workerProtocol.ts";

/**
 * The composable's durable state, pause ownership and thumbnail binding —
 * everything but the pixels. `state` must be reactive for the phase and
 * journal watchers; the tests only touch the fields the map reads.
 */
function makeHarness(storage?: Pick<Storage, "getItem" | "setItem">): {
  map: ReturnType<typeof useRoomMap>;
  state: EngineState;
  hook: TextHook;
  pauses: number;
  resumes: number;
  notice(entry: Partial<RoomTransitionNotice> & { to: number }): void;
  frame(cycle: number, patchGeneration?: number): Frame;
  boot(files?: Record<string, Uint8Array>): Promise<void>;
} {
  let pauses = 0;
  let resumes = 0;
  let seq = 0;
  // Only the fields the map reads; the rest of EngineState is irrelevant here.
  const state = reactive({
    phase: "idle",
    paused: false,
    powerUp: { open: false },
    roomJournal: [] as RoomTransitionNotice[],
  }) as unknown as EngineState;
  const hook = reactive({ room: -1 }) as unknown as TextHook;
  const game: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: "rev-1",
    files: {},
    words: [],
    folder: "test-game",
  };
  const map = useRoomMap({
    state,
    hook,
    getBootedGame: () => game,
    getSession: () => null,
    pauseEngine: () => {
      pauses++;
      state.paused = true;
    },
    resumeEngine: () => {
      resumes++;
      state.paused = false;
    },
    storage,
  });
  return {
    map,
    state,
    hook,
    get pauses() {
      return pauses;
    },
    get resumes() {
      return resumes;
    },
    notice(entry) {
      state.roomJournal.push({
        type: "roomTransition",
        seq: ++seq,
        from: null,
        cause: "logic",
        cycle: 1,
        patchGeneration: 0,
        scoreDelta: 0,
        gained: [],
        lost: [],
        ...entry,
      });
    },
    frame(cycle, patchGeneration = 0) {
      return {
        visual: new Uint8Array(160 * 168),
        cycle,
        patchGeneration,
      } as Frame;
    },
    async boot(files) {
      if (files) (game as { files: Record<string, Uint8Array> }).files = files;
      state.phase = "running";
      await nextTick();
    },
  };
}

test("notices drain into a durable journal and observed graph nodes", async () => {
  const { map, notice, boot } = makeHarness();
  await boot();
  notice({ to: 0, cause: "boot", cycle: 1 });
  notice({ to: 2, from: 0, cause: "edge", edge: "right", cycle: 9, scoreDelta: 3 });
  await nextTick();
  assert.equal(map.journal.length, 2);
  const node = map.graph.value.nodes.find((n) => n.room === 2);
  assert.ok(node?.observed);
  assert.equal(node.visits, 1);
  const edge = map.graph.value.edges.find((e) => e.provenance === "observed");
  assert.deepEqual(
    { from: edge?.from, to: edge?.to, label: edge?.label },
    { from: 0, to: 2, label: "right" },
  );
});

test("the map pauses on open and resumes only a pause it owns", async () => {
  const { map, state, boot } = makeHarness();
  await boot();
  map.openMap();
  assert.equal(map.open.value, true);
  assert.equal(state.paused, true);
  map.closeMap();
  assert.equal(state.paused, false);

  // Already paused by something else: the map must not release it.
  state.paused = true;
  map.openMap();
  map.closeMap();
  assert.equal(state.paused, true);
});

test("a pause the remix bubble still holds is not released by the map", async () => {
  const { map, state, boot } = makeHarness();
  await boot();
  map.openMap();
  state.powerUp.open = true; // the bubble took over while the map was open
  map.closeMap();
  assert.equal(state.paused, true);
});

test("frames bind to rooms only through the exact pending identity", async () => {
  const { map, notice, frame, boot } = makeHarness();
  await boot();
  notice({ to: 5, cause: "boot", cycle: 7, patchGeneration: 0 });
  await nextTick();
  map.observeFrame(frame(8, 0)); // wrong cycle: never "the next frame"
  assert.equal(map.thumbnailFor(5), null);
  map.observeFrame(frame(7, 0));
  const thumb = map.thumbnailFor(5);
  assert.equal(thumb?.kind, "observed");
  assert.equal(thumb?.pixels.length, 160 * 168);
});

test("a stale patch generation cannot repaint a room", async () => {
  const { map, notice, frame, boot } = makeHarness();
  await boot();
  notice({ to: 1, cause: "boot", cycle: 3, patchGeneration: 0 });
  notice({ to: 4, from: 1, cause: "edge", edge: "left", cycle: 5, patchGeneration: 2 });
  await nextTick();
  map.observeFrame(frame(3, 2)); // right cycle, wrong generation
  assert.equal(map.thumbnailFor(1), null);
  map.observeFrame(frame(5, 2));
  assert.equal(map.thumbnailFor(4)?.kind, "observed");
});

test("layout moves persist; a write failure surfaces as unsaved", async () => {
  const values = new Map<string, string>();
  let writes = true;
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (!writes) throw new DOMException("quota", "QuotaExceededError");
      values.set(k, v);
    },
  };
  const { map, boot } = makeHarness(storage);
  await boot();
  map.moveNode(3, 100, 200);
  assert.deepEqual(map.positionFor(3), { x: 100, y: 200 });
  assert.equal(map.unsaved.value, false);
  writes = false;
  map.moveNode(3, 110, 210);
  assert.equal(map.unsaved.value, true);
  writes = true;
  map.retrySave();
  assert.equal(map.unsaved.value, false);
});

test("journal survives a reload through storage", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  };
  const first = makeHarness(storage);
  await first.boot();
  first.notice({ to: 0, cause: "boot", cycle: 1 });
  first.notice({ to: 2, from: 0, cause: "edge", edge: "right", cycle: 4 });
  await nextTick();

  const second = makeHarness(storage);
  await second.boot();
  assert.equal(second.map.journal.length, 2);
  assert.equal(second.map.journal[1]?.to, 2);
  // A reloaded journal starts a new session: old entries keep theirs.
  assert.equal(second.map.journal[0]?.session, 1);
});

test("unloading the game releases the map without leaking into the next", async () => {
  const { map, state, notice, boot } = makeHarness();
  await boot();
  notice({ to: 0, cause: "boot", cycle: 1 });
  await nextTick();
  state.phase = "idle";
  await nextTick();
  assert.equal(map.open.value, false);
  assert.equal(map.journal.length, 0);
  assert.equal(map.graph.value.nodes.length, 0);
});
