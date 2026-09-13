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
  wtPauses: number;
  wtResumes: number;
  notice(entry: Partial<RoomTransitionNotice> & { to: number }): void;
  frame(cycle: number, patchGeneration?: number): Frame;
  boot(files?: Record<string, Uint8Array>): Promise<void>;
} {
  let pauses = 0;
  let resumes = 0;
  let wtPauses = 0;
  let wtResumes = 0;
  let seq = 0;
  // Only the fields the map reads; the rest of EngineState is irrelevant here.
  const state = reactive({
    phase: "idle",
    paused: false,
    powerUp: { open: false },
    roomJournal: [] as RoomTransitionNotice[],
    walkthrough: { active: false, status: "idle", tick: 0 },
    patchTick: 0,
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
    pauseWalkthrough: () => {
      wtPauses++;
      if (state.walkthrough.status === "playing") state.walkthrough.status = "paused";
    },
    resumeWalkthrough: () => {
      wtResumes++;
      if (state.walkthrough.status === "paused") state.walkthrough.status = "playing";
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
    get wtPauses() {
      return wtPauses;
    },
    get wtResumes() {
      return wtResumes;
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

test("directional edges place rooms on the side they were reached from", async () => {
  const { map, notice, boot } = makeHarness();
  await boot();
  notice({ to: 0, cause: "boot", cycle: 1 });
  // KQ1 room 1: left edge → 2, right edge → 8, top edge → 16, bottom → 5.
  notice({ to: 2, from: 0, cause: "edge", edge: "left", cycle: 2 });
  notice({ to: 8, from: 0, cause: "edge", edge: "right", cycle: 3 });
  notice({ to: 16, from: 0, cause: "edge", edge: "top", cycle: 4 });
  notice({ to: 5, from: 0, cause: "edge", edge: "bottom", cycle: 5 });
  await nextTick();
  const home = map.positionFor(0);
  assert.ok(map.positionFor(2).x < home.x, "left-exit room must lie left");
  assert.ok(map.positionFor(8).x > home.x, "right-exit room must lie right");
  assert.ok(map.positionFor(16).y < home.y, "top-exit room must lie above");
  assert.ok(map.positionFor(5).y > home.y, "bottom-exit room must lie below");
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

test("the map pauses the walkthrough driver and resumes only a pause it owns", async () => {
  const h = makeHarness();
  const { map, state } = h;
  await h.boot();
  state.walkthrough.active = true;
  state.walkthrough.status = "playing";

  map.openMap();
  assert.equal(h.wtPauses, 1);
  assert.equal(state.walkthrough.status, "paused");
  map.closeMap();
  assert.equal(h.wtResumes, 1);
  assert.equal(state.walkthrough.status, "playing");

  // Already paused by the player: the map must not release it on close.
  state.walkthrough.status = "paused";
  map.openMap();
  map.closeMap();
  assert.equal(h.wtPauses, 1);
  assert.equal(state.walkthrough.status, "paused");
});

test("current room follows the live position, not the journal's last entry", async () => {
  const { map, state, hook, notice, boot } = makeHarness();
  await boot();
  notice({ to: 1, cause: "boot", cycle: 1 });
  await nextTick();
  // A replay seek moved the engine to room 8 with no journal entry: the
  // durable record says 1, the live hook says 8 — the marker shows 8.
  hook.room = 8;
  assert.equal(map.currentRoom.value, 8);
  // After eject the journal's last entry is the only known position.
  state.phase = "idle";
  await nextTick();
  assert.equal(map.currentRoom.value, null);
});

test("journal eviction never erases discovered rooms or walked edges", async () => {
  const { map, notice, boot } = makeHarness();
  await boot();
  notice({ to: 1, cause: "boot", cycle: 1 });
  notice({ to: 2, from: 1, cause: "edge", edge: "right", cycle: 2 });
  // Push the detailed journal past its 4096-entry cap with later re-entries.
  for (let i = 0; i < 4100; i++) notice({ to: 2, from: 2, cause: "edge", edge: "top", cycle: i });
  await nextTick();
  assert.equal(map.journal.length, 4096);
  const rooms = map.graph.value.nodes.map((n) => n.room);
  // Room 1's detail is evicted but the visit fact survives.
  assert.ok(rooms.includes(1));
  assert.ok(rooms.includes(2));
  const node = map.graph.value.nodes.find((n) => n.room === 1);
  assert.equal(node?.observed, true);
  assert.equal(node?.visits, 1);
  const edge = map.graph.value.edges.find(
    (e) => e.from === 1 && e.to === 2 && e.provenance === "observed",
  );
  assert.equal(edge?.count, 1);
});

test("stored tests mark validated rooms and covered transitions", async () => {
  const tests = new TextEncoder().encode(
    JSON.stringify({
      format: "monotio.agi.tests.v1",
      tests: [
        {
          name: "walk to the castle",
          room: 1,
          steps: [{ action: "wait", until: { room: 3 } }],
          expect: { room: 5 },
        },
      ],
    }),
  );
  const { map, notice, boot } = makeHarness();
  await boot({ "TESTS.JSON": tests });
  notice({ to: 1, cause: "boot", cycle: 1 });
  notice({ to: 3, from: 1, cause: "edge", edge: "right", cycle: 2 });
  notice({ to: 5, from: 3, cause: "logic", cycle: 3 });
  await nextTick();
  const graph = map.graph.value;
  for (const room of [1, 3, 5])
    assert.equal(graph.nodes.find((n) => n.room === room)?.validated, true, `room ${room}`);
  // The recorded run named 1 → 3 → 5; both observed edges carry the flag.
  assert.equal(graph.edges.find((e) => e.from === 1 && e.to === 3)?.tested, true);
  assert.equal(graph.edges.find((e) => e.from === 3 && e.to === 5)?.tested, true);
});
