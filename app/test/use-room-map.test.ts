import assert from "node:assert/strict";
import { test } from "node:test";
import { testProjectId, testRevision } from "./identity.ts";
import { computed, nextTick, reactive } from "vue";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { createAuthoringState } from "../../src/agent/authoringState.ts";
import { commitWorldDraft, worldRevision, type WorldDraft } from "../../src/agent/worldPlan.ts";
import { useRoomMap } from "../src/useRoomMap.ts";
import type { AgentSession } from "../src/agent/agentSession.ts";
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
  pauseAs(owner: string): void;
  notice(entry: Partial<RoomTransitionNotice> & { to: number }): void;
  frame(cycle: number, patchGeneration?: number): Frame;
  boot(files?: Record<string, Uint8Array>): Promise<void>;
} {
  let pauses = 0;
  let resumes = 0;
  let wtPauses = 0;
  let wtResumes = 0;
  let seq = 0;
  // The owner set mirrors useEngine's pause bookkeeping: the engine stays
  // paused while any owner holds it, whoever paused first.
  const owners = new Set<string>();
  // Only the fields the map reads; the rest of EngineState is irrelevant here.
  const state = reactive({
    phase: "idle",
    paused: false,
    powerUp: { open: false },
    roomJournal: [] as RoomTransitionNotice[],
    walkthrough: { active: false, status: "idle", tick: 0 },
    patchTick: 0,
    worldTick: 0,
    agentLog: [],
  }) as unknown as EngineState;
  const hook = reactive({ room: -1 }) as unknown as TextHook;
  const game: BootedGame = {
    installed: true,
    title: "Test Game",
    revision: testRevision("rev-1"),
    files: {},
    words: [],
    folder: "test-game",
  };
  const map = useRoomMap({
    state,
    hook,
    getBootedGame: () => game,
    getSession: () => null,
    pauseEngine: (owner = "generic") => {
      pauses++;
      owners.add(owner);
      state.paused = owners.size > 0;
    },
    resumeEngine: (owner = "generic") => {
      resumes++;
      owners.delete(owner);
      state.paused = owners.size > 0;
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
    pauseAs(owner: string) {
      owners.add(owner);
      state.paused = true;
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
  const { map, state, boot, pauseAs } = makeHarness();
  await boot();
  map.openMap();
  assert.equal(map.open.value, true);
  assert.equal(state.paused, true);
  map.closeMap();
  assert.equal(state.paused, false);

  // Another owner holds the pause: closing the map must not release it.
  pauseAs("powerUp");
  map.openMap();
  map.closeMap();
  assert.equal(state.paused, true);
});

test("a pause the remix bubble still holds is not released by the map", async () => {
  const { map, state, boot, pauseAs } = makeHarness();
  await boot();
  map.openMap();
  pauseAs("powerUp"); // the bubble took over while the map was open
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

test("a room placed before its labeled edge arrives re-places on the named side", async () => {
  const { map, notice, boot } = makeHarness();
  await boot();
  notice({ to: 1, cause: "boot", cycle: 1 });
  notice({ to: 2, from: 1, cause: "logic", cycle: 2 });
  await nextTick();
  // No direction evidence yet: the fallback anchors room 2 right of room 1.
  const p1 = map.positionFor(1);
  assert.ok(map.positionFor(2).x > p1.x);
  // The observed edge lands later: left edge of room 1 → room 2 is LEFT.
  notice({ to: 2, from: 1, cause: "edge", edge: "left", cycle: 3 });
  await nextTick();
  await nextTick(); // the graph watcher invalidates auto positions
  // Positions derive in node order, as the component's positions computed does.
  for (const n of map.graph.value.nodes) map.positionFor(n.room);
  assert.ok(map.positionFor(2).x < p1.x);
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

test("discovery retains every distinct edge the room domain allows", async () => {
  const { map, notice, boot } = makeHarness();
  await boot();
  notice({ to: 0, cause: "boot", cycle: 0 });
  const sides = ["top", "right", "bottom", "left"] as const;
  // 1,280 distinct directed transitions — past the old 1,024 cap — then
  // enough repeats of one hop to evict the detailed journal entirely.
  for (let i = 0; i < 1280; i++)
    notice({
      to: i % 256,
      from: Math.floor(i / 5) % 256,
      cause: "edge",
      edge: sides[i % 4]!,
      cycle: i + 1,
    });
  for (let i = 0; i < 4100; i++)
    notice({ to: 0, from: 0, cause: "edge", edge: "top", cycle: 2000 + i });
  await nextTick();
  assert.equal(map.journal.length, 4096);
  const observed = map.graph.value.edges.filter((e) => e.provenance === "observed");
  // Every distinct transition survived; the 0->0/top eviction entries merge
  // into the identical key already produced at i=0.
  assert.equal(observed.length, 1280);
  // A late, arbitrary member of the distinct set is still present
  // (i=511 → from=102, to=255, label "left").
  assert.ok(observed.some((e) => e.from === 102 && e.to === 255 && e.label === "left"));
});

test("thumbnail reads are pure — no render, no version churn", async () => {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 3, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    1,
    // v0 is selfRoom → the scan attributes picture 1 to room 1.
    assembleLogic("load.pic(v0);draw.pic(v0);return;", { dictionary: new Map() }).payload,
  );
  const { map, notice, boot } = makeHarness();
  await boot(Object.fromEntries(game.files));
  notice({ to: 1, cause: "boot", cycle: 1 });
  await nextTick();
  await nextTick(); // the graph watcher prepares static thumbs off-read
  const first = map.thumbnailFor(1);
  assert.equal(first?.kind, "static");
  const settled = map.thumbVersion.value;
  for (let i = 0; i < 3; i++) assert.equal(map.thumbnailFor(1), first);
  assert.equal(map.thumbVersion.value, settled);
});

test("a stored test references its rooms but proves no traversal", async () => {
  // A definition with no stored run result — the zero-step test in the plan's
  // probe marks intent only: rooms are referenced, edges carry no flag.
  const tests = new TextEncoder().encode(
    JSON.stringify({
      format: "monotio.agi.tests.v1",
      tests: [
        { name: "Unrun", room: 1, steps: [], expect: { room: 8 } },
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
  // Test coverage is a technical status — only the creator surface shows it.
  map.openMap({ experience: "create" });
  notice({ to: 1, cause: "boot", cycle: 1 });
  notice({ to: 8, from: 1, cause: "edge", edge: "right", cycle: 2 });
  // Rooms 3 and 5 need their own evidence — coverage never invents a node.
  notice({ to: 3, from: 1, cause: "logic", cycle: 3 });
  notice({ to: 5, from: 3, cause: "logic", cycle: 4 });
  await nextTick();
  const graph = map.graph.value;
  for (const room of [1, 3, 5, 8])
    assert.equal(graph.nodes.find((n) => n.room === room)?.referenced, true, `room ${room}`);
  // Even a real 1 -> 8 edge gets no coverage flag — an unrun test asserts
  // arrival, not which transition was exercised.
  const edge = graph.edges.find((e) => e.from === 1 && e.to === 8);
  assert.ok(edge);
  assert.equal(Object.hasOwn(edge, "tested"), false);
});

// ---- the map as the plan surface --------------------------------------------

/**
 * A session stand-in that commits drafts through the real revision check —
 * the same shape the map reads (state.authoring + commitPlanDraft).
 */
function fakeSession(
  rooms: Record<string, { title: string; description: string; exits: Record<string, number> }>,
): AgentSession {
  const state = { authoring: createAuthoringState() };
  state.authoring.world.rooms = rooms;
  return {
    state,
    getAuthoringState: () => ({ authoring: state.authoring }),
    getMessages: () => [],
    commitPlanDraft: (draft: WorldDraft) => {
      const result = commitWorldDraft(state.authoring, draft);
      if (result.status === "committed") state.authoring = result.authoring;
      return result;
    },
  } as unknown as AgentSession;
}

function planHarness(opts: {
  session?: AgentSession | null;
  storage?: Pick<Storage, "getItem" | "setItem">;
  onWorldEdited?: () => boolean | void | Promise<boolean | void>;
  buildRoomFromMap?: (
    room: number,
    from: number,
    notes: string[],
    exitName?: string,
  ) => Promise<void>;
}) {
  const state = reactive({
    phase: "idle",
    paused: false,
    powerUp: { open: false },
    roomJournal: [] as RoomTransitionNotice[],
    walkthrough: { active: false, status: "idle", tick: 0 },
    patchTick: 0,
    worldTick: 0,
    planDurableRev: "",
    agentLog: [],
  }) as unknown as EngineState;
  const hook = reactive({ room: -1 }) as unknown as TextHook;
  const game: BootedGame = {
    installed: false,
    projectId: testProjectId("proj-1"),
    title: "Authored",
    revision: testRevision("rev-1"),
    files: {},
    words: [],
  };
  const map = useRoomMap({
    state,
    hook,
    getBootedGame: () => game,
    getSession: () => opts.session ?? null,
    pauseEngine: () => {
      state.paused = true;
    },
    resumeEngine: () => {
      state.paused = false;
    },
    pauseWalkthrough: () => {},
    resumeWalkthrough: () => {},
    storage: opts.storage,
    onWorldEdited: opts.onWorldEdited,
    buildRoomFromMap: opts.buildRoomFromMap,
  });
  return { map, state, game };
}

test("the map defaults to the play experience — no plan, no plan actions", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: { east: 2 } },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const { map, state } = planHarness({ session });
  state.phase = "running";
  map.openMap();
  assert.equal(map.experience.value, "play");
  assert.equal(map.planAvailable.value, true, "a plan exists — the entry point may offer it");
  assert.equal(map.canPlan.value, false);
  // The graph shows only what the player knows: visited rooms, no planned nodes.
  assert.equal(
    map.graph.value.nodes.find((n) => n.room === 2),
    undefined,
  );
  assert.equal(
    map.graph.value.edges.some((e) => e.provenance === "planned"),
    false,
  );
  // Plan reads and writes refuse on the play surface.
  assert.equal(map.plannedEntry(2), null);
  assert.match(map.renamePlannedRoom(1, "Meadow") ?? "", /creator action/);
  assert.equal(session.state.authoring.world.rooms["1"]?.title, "Hall");
  await map.buildPlannedRoom(2); // a no-op refusal — never a thrown plan write
  assert.equal(map.buildingRoom.value, undefined);
});

test("the create experience exposes the plan and its edit affordances", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: { east: 2 } },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const { map, state } = planHarness({ session });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.experience.value, "create");
  assert.equal(map.canPlan.value, true);
  assert.equal(map.plannedEntry(2)?.title, "Vault");
  assert.ok(
    map.graph.value.edges.some((e) => e.provenance === "planned" && e.from === 1 && e.to === 2),
  );
  // Closing and reopening without an experience returns to the play default.
  map.closeMap();
  map.openMap();
  assert.equal(map.experience.value, "play");
  assert.equal(map.canPlan.value, false);
});

test("an imported game offers no plan surface even asked as creator", async () => {
  // No session: imports carry no editable world plan, so "create" degrades
  // to the discovered view rather than showing plan affordances.
  const { map, state } = planHarness({ session: null });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.planAvailable.value, false);
  assert.equal(map.canPlan.value, false, "nothing to edit");
  assert.equal(map.plannedEntry(1), null);
});

test("live edits land on the session world and the map drives the planned layer", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: { east: 2 } },
    "2": { title: "Vault", description: "", exits: {} },
  });
  let edited = 0;
  const { map, state } = planHarness({
    session,
    onWorldEdited: () => {
      edited++;
    },
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.plannedEntry(2)?.title, "Vault");
  assert.ok(map.graph.value.nodes.find((n) => n.room === 2)?.planned);

  assert.equal(map.renamePlannedRoom(1, "Meadow"), null);
  assert.equal(session.state.authoring.world.rooms["1"]?.title, "Meadow");
  assert.equal(edited, 1);
  // A refused edit leaves the world untouched and says why.
  assert.match(map.renamePlannedRoom(9, "Nope") ?? "", /not in the plan/);
  assert.equal(map.planError.value !== "", true);
  assert.equal(session.state.authoring.world.rooms["9"], undefined);
  // Add a room off room 1 — node and exit in one validated edit.
  const added = map.addPlannedRoom(1, "Tower", "A tall tower.", "up");
  assert.equal(added.room, 3);
  assert.equal(session.state.authoring.world.rooms["3"]?.title, "Tower");
  assert.equal(session.state.authoring.world.rooms["1"]?.exits["up"], 3);
});

test("Build this room authors against the planned inbound edge, notes as intent", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Landing", description: "", exits: { north: 3 } },
    "3": { title: "Vault", description: "The loot.", exits: {} },
  });
  const roomBuilds: { room: number; from: number; notes: string[]; exitName?: string }[] = [];
  const { map, state } = planHarness({
    session,
    buildRoomFromMap: async (room, from, notes, exitName) => {
      roomBuilds.push({ room, from, notes, ...(exitName ? { exitName } : {}) });
    },
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  map.setNote(3, "the vault door should feel trapped");
  map.setEdgeNote(2, 3, "north", "the guard watches this way");
  await map.buildPlannedRoom(3);
  assert.equal(roomBuilds.length, 1);
  assert.equal(roomBuilds[0]?.room, 3);
  assert.equal(roomBuilds[0]?.from, 2); // the plan's north exit targets it
  assert.equal(roomBuilds[0]?.exitName, "north", "the planned exit name reaches the build");
  assert.deepEqual(roomBuilds[0]?.notes, [
    "the vault door should feel trapped",
    'exit from room 2 "north": the guard watches this way',
  ]);
  assert.equal(map.buildingRoom.value, undefined);
  // A room that is not in the plan refuses instead of building.
  await map.buildPlannedRoom(9);
  assert.equal(roomBuilds.length, 1);
  assert.match(map.planError.value, /not in the plan/);
});

test("the map may close while a room build is in flight; the bubble takes over its progress", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  let release: (() => void) | null = null;
  const { map, state } = planHarness({
    session,
    buildRoomFromMap: () => new Promise<void>((resolve) => (release = resolve)),
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  const building = map.buildPlannedRoom(2);
  await nextTick();
  assert.equal(map.buildingRoom.value, 2);

  map.closeMap();
  assert.equal(map.open.value, false, "closing mid-build is allowed");
  assert.equal(state.powerUp.mode, "room", "the build's progress moved to the bubble");
  assert.equal(state.powerUp.room, 2);
  assert.equal(state.powerUp.busy, true);

  release!();
  await building;
  assert.equal(state.powerUp.busy, false, "a landed build settles the bubble");
  assert.equal(state.powerUp.open, false);
});

test("live edits commit through the session's revision check", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  let edited = 0;
  const { map, state } = planHarness({
    session,
    onWorldEdited: () => {
      edited++;
    },
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.plannedEntry(2)?.title, "Vault");
  assert.equal(map.renamePlannedRoom(1, "Parlor"), null);
  assert.equal(edited, 1);
  assert.equal(
    (
      session.getAuthoringState() as {
        authoring: { world: { rooms: Record<string, { title: string }> } };
      }
    ).authoring.world.rooms["1"]?.title,
    "Parlor",
  );
  // A move under the edit's fork is a conflict, not a silent overwrite —
  // commitWorldDraft refuses because the draft's base is stale. The map
  // reports the refusal and the world keeps the concurrent change.
  session.state.authoring.world.facts["elsewhere"] = "moved";
  // Each live edit forks fresh from the current world, so a second edit
  // still commits — conflicts only surface inside one edit's fork+commit.
  assert.equal(map.renamePlannedRoom(2, "Crypt"), null);
  assert.equal(session.state.authoring.world.facts["elsewhere"], "moved");
  map.closeMap();
});

test("a visited room cannot be removed from the plan", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const { map, state } = planHarness({ session });
  state.phase = "running";
  await nextTick(); // loadFor drains and resets first; the visit lands after
  state.roomJournal.push({
    type: "roomTransition",
    seq: 1,
    from: 1,
    to: 2,
    cause: "edge",
    edge: "right",
    cycle: 4,
    patchGeneration: 0,
    scoreDelta: 0,
    gained: [],
    lost: [],
  });
  await nextTick();
  map.openMap({ experience: "create" });
  assert.match(map.removePlannedRoom(2) ?? "", /record|visited|built/i);
  assert.ok(map.plannedEntry(2), "the plan keeps the visited room");
  map.closeMap();
});

test("edge notes persist through the sidecar and join the room's intent", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  };
  const first = planHarness({ storage });
  // Boot the authored game so the sidecar loads under its project key.
  first.state.phase = "running";
  await nextTick();
  first.map.setEdgeNote(1, 2, "east", "the bridge is out at night");
  first.map.setNote(2, "moody vault");
  // Edge notes carry their provenance — the room prompt can tell a pinned
  // fact about the connection from a fact about the room itself.
  assert.deepEqual(
    first.map.noteIntentFor(2).sort(),
    ['exit from room 1 "east": the bridge is out at night', "moody vault"].sort(),
  );

  const second = planHarness({ storage });
  second.state.phase = "running";
  await nextTick();
  assert.equal(second.map.edgeNoteFor(1, 2, "east"), "the bridge is out at night");
});

test("a plan update under an open edit refreshes clean fields and flags dirty ones", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "The entry.", exits: {} },
    "2": { title: "Vault", description: "The loot.", exits: {} },
  });
  const { map, state } = planHarness({ session });
  state.phase = "running";
  map.openMap({ experience: "create" });
  const edit = map.beginPlanEdit(2)!;
  assert.equal(edit.title.draft, "Vault");
  assert.equal(edit.brief.draft, "The loot.");
  // The user is mid-edit on the brief; the title is untouched.
  edit.brief.draft = "Guarded by a troll.";
  // An agent turn lands: room 2's title and brief both changed underneath.
  session.state.authoring.world.rooms["2"] = {
    title: "Treasury",
    description: "Agent rewrite.",
    exits: {},
  };
  map.syncPlanEdit(edit);
  // The clean title followed the plan; the dirty brief is a flagged
  // conflict whose draft keeps the user's text.
  assert.equal(edit.title.draft, "Treasury");
  assert.equal(edit.title.conflict, null);
  assert.equal(edit.brief.draft, "Guarded by a troll.");
  assert.equal(edit.brief.conflict, "Agent rewrite.");
  // Submitting the stale field is a conflict, not an overwrite.
  assert.equal(map.commitPlanField(edit, "brief"), "conflict");
  assert.equal(session.state.authoring.world.rooms["2"]?.description, "Agent rewrite.");
  // Explicit reconciliation: keep mine writes the user's text…
  assert.equal(map.resolvePlanField(edit, "brief", "mine"), null);
  assert.equal(session.state.authoring.world.rooms["2"]?.description, "Guarded by a troll.");
  assert.equal(edit.brief.conflict, null);
  // A committed field is clean — the next agent update simply follows it.
  session.state.authoring.world.rooms["2"]!.description = "Agent again.";
  map.syncPlanEdit(edit);
  assert.equal(edit.brief.draft, "Agent again.");
  assert.equal(edit.brief.conflict, null);
  // Re-dirty and re-flag, then reconcile with the plan's text.
  edit.brief.draft = "A quiet cellar.";
  session.state.authoring.world.rooms["2"]!.description = "Agent twice.";
  map.syncPlanEdit(edit);
  assert.equal(edit.brief.conflict, "Agent twice.");
  assert.equal(map.resolvePlanField(edit, "brief", "plan"), null);
  assert.equal(edit.brief.draft, "Agent twice.");
});

test("a clean field's commit survives an unrelated field's update", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "The loot.", exits: {} },
  });
  const { map, state } = planHarness({ session });
  state.phase = "running";
  map.openMap({ experience: "create" });
  const edit = map.beginPlanEdit(2)!;
  edit.title.draft = "Crypt";
  // The agent touched another field of the same room — not the title. The
  // clean brief simply follows; the dirty title's base still matches.
  session.state.authoring.world.rooms["2"]!.description = "Agent rewrite.";
  map.syncPlanEdit(edit);
  assert.equal(edit.title.conflict, null);
  assert.equal(edit.title.draft, "Crypt");
  assert.equal(edit.brief.draft, "Agent rewrite.");
  assert.equal(edit.brief.conflict, null);
  assert.equal(map.commitPlanField(edit, "title"), null);
  assert.equal(session.state.authoring.world.rooms["2"]?.title, "Crypt");
  assert.equal(session.state.authoring.world.rooms["2"]?.description, "Agent rewrite.");
});

test("plan reads re-derive on worldTick — a plan-only turn invalidates the map", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const { map, state } = planHarness({ session });
  state.phase = "running";
  map.openMap({ experience: "create" });
  const title = computed(() => map.plannedEntry(2)?.title);
  assert.equal(title.value, "Vault");
  // A plan-only update_world lands no resource patch — only worldTick moves.
  session.state.authoring.world.rooms["2"]!.title = "Treasury";
  await nextTick();
  assert.equal(title.value, "Vault", "no signal yet — the read is stale");
  state.worldTick++;
  await nextTick();
  assert.equal(title.value, "Treasury");
});

test("a refused plan write keeps edits in memory; Retry lands the same revision", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  let fail = true;
  let calls = 0;
  const { map, state } = planHarness({
    session,
    onWorldEdited: () => {
      calls++;
      return Promise.resolve(!fail);
    },
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  // The opening revision is what storage handed us — clean before any edit.
  assert.equal(map.planDirty.value, false);

  assert.equal(map.renamePlannedRoom(2, "Crypt"), null);
  await nextTick();
  await nextTick(); // the persist's ack is a microtask behind the commit
  assert.equal(calls, 1);
  // Refused: the newer revision was never written, so it must not read saved.
  assert.equal(map.planDirty.value, true);
  assert.match(map.planSaveError.value, /could not be saved/);

  // Closing and reopening retains the in-memory edit and the flag.
  map.closeMap();
  map.openMap({ experience: "create" });
  assert.equal(map.plannedEntry(2)?.title, "Crypt");
  assert.equal(map.planDirty.value, true);
  assert.equal(calls, 1);

  // Retry writes the exact in-memory revision; the map labels it durable.
  fail = false;
  await map.retryPlanSave();
  const durable = worldRevision(session.state.authoring.world);
  assert.equal(state.planDurableRev, durable);
  assert.equal(map.planDirty.value, false);
  assert.equal(map.planSaveError.value, "");
  assert.equal(calls, 2);
});

test("a late ack for an older write cannot label newer content saved", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  // Mimic the real channel: the persist captures the revision it writes and
  // reports it into planDurableRev only when the write resolves.
  const written: string[] = [];
  const release: ((v: boolean) => void)[] = [];
  const { map, state } = planHarness({
    session,
    onWorldEdited: () => {
      const rev = worldRevision(session.state.authoring.world);
      written.push(rev);
      return new Promise<boolean>((resolve) =>
        release.push((v) => {
          if (v) state.planDurableRev = rev;
          resolve(v);
        }),
      );
    },
  });
  state.phase = "running";
  map.openMap({ experience: "create" });

  assert.equal(map.renamePlannedRoom(1, "Parlor"), null); // write 1: rev A
  assert.equal(map.renamePlannedRoom(2, "Crypt"), null); // write 2: rev B
  await nextTick();
  assert.equal(written.length, 2);
  assert.notEqual(written[0], written[1]);

  // The older write's ack lands while the newer one is still out: it reports
  // rev A, which is not the current rev B — the flag must stay dirty.
  release[0]!(true);
  await nextTick();
  await nextTick();
  assert.equal(state.planDurableRev, written[0]);
  assert.equal(map.planDirty.value, true, "rev B is newer than the acked rev A");

  // The newer write's ack reports rev B — now edited and durable agree.
  release[1]!(true);
  await nextTick();
  await nextTick();
  assert.equal(map.planDirty.value, false);
});

test("a newer durable report mid-flight is never overwritten by a stale ack", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const release: ((v: boolean) => void)[] = [];
  const { map, state } = planHarness({
    session,
    // This channel acknowledges without reporting — the controller's own
    // report is what must survive the late ack, not the map's fill-in.
    onWorldEdited: () => new Promise<boolean>((r) => release.push(r)),
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.renamePlannedRoom(2, "Crypt"), null);
  await nextTick();
  assert.equal(release.length, 1);

  // A different save (an agent turn's persist) reported a newer revision
  // while the map's write was still in flight.
  state.planDurableRev = "rev-from-agent-turn";
  release[0]!(true);
  await nextTick();
  await nextTick();
  // The map's fill-in must not roll durable back to the rev it wrote.
  assert.equal(state.planDurableRev, "rev-from-agent-turn");
  assert.equal(map.planSaveError.value, "");
  assert.equal(map.planDirty.value, true, "current rev differs from the reported one");
});

test("an older write's late refusal cannot surface over a newer write's success", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const release: ((v: boolean) => void)[] = [];
  const { map, state } = planHarness({
    session,
    onWorldEdited: () => new Promise<boolean>((r) => release.push(r)),
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.renamePlannedRoom(1, "Parlor"), null); // write 1 in flight
  assert.equal(map.renamePlannedRoom(2, "Crypt"), null); // write 2 in flight
  await nextTick();
  // The newer write — carrying both edits — lands first.
  release[1]!(true);
  await nextTick();
  await nextTick();
  assert.equal(map.planSaveError.value, "");
  assert.equal(map.planDirty.value, false);
  // The superseded write's refusal arrives late: both edits are already
  // durable through write 2, so nothing is a current failure.
  release[0]!(false);
  await nextTick();
  await nextTick();
  assert.equal(map.planSaveError.value, "");
  assert.equal(map.planDirty.value, false);
});

test("the in-memory revision stays exportable while the write is refused", async () => {
  const session = fakeSession({
    "1": { title: "Hall", description: "", exits: {} },
    "2": { title: "Vault", description: "", exits: {} },
  });
  const { map, state } = planHarness({
    session,
    onWorldEdited: () => Promise.resolve(false),
  });
  state.phase = "running";
  map.openMap({ experience: "create" });
  assert.equal(map.renamePlannedRoom(2, "Crypt"), null);
  await nextTick();
  await nextTick();
  assert.equal(map.planDirty.value, true);
  // The export path serializes getAuthoringState() — the refused write's
  // content is still exactly what an export carries.
  const snapshot = session.getAuthoringState() as {
    authoring: { world: { rooms: Record<string, { title: string }> } };
  };
  assert.equal(snapshot.authoring.world.rooms["2"]?.title, "Crypt");
});
