import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, reactive } from "vue";
import { testProjectId, testRevision } from "./identity.ts";
import { useRoomMap } from "../src/world/useRoomMap.ts";
import { mapKey } from "../src/world/roomMapStore.ts";
import { installedProgressLocator } from "../src/project/progressTarget.ts";
import type { EngineState, TextHook } from "../src/engine/useEngineTypes.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import type { RoomTransitionNotice } from "../src/worker/workerProtocol.ts";

/**
 * The map's binding to the game's physical progress target: an installed
 * instance writes under `installed:<folder-digest>:<revision>`, a saved body under
 * `project:<id>:<epoch>`. The harness's live game object is switchable so a
 * mid-run swap or a delete/recreate can be observed without a phase
 * transition — that is where a queued write must refuse.
 */
function makeHarness(storage?: Pick<Storage, "getItem" | "setItem">): {
  map: ReturnType<typeof useRoomMap>;
  state: EngineState;
  setGame(game: BootedGame | null): void;
  boot(game: BootedGame | null): Promise<void>;
  eject(): Promise<void>;
  notice(entry: Partial<RoomTransitionNotice> & { to: number }): void;
} {
  let seq = 0;
  const state = reactive({
    phase: "idle",
    roomJournal: [] as RoomTransitionNotice[],
    walkthrough: { active: false, status: "idle", tick: 0 },
    patchTick: 0,
    worldTick: 0,
    agentLog: [],
    powerUp: { open: false },
  }) as unknown as EngineState;
  const hook = reactive({ room: -1 }) as unknown as TextHook;
  let live: BootedGame | null = null;
  const map = useRoomMap({
    state,
    hook,
    getBootedGame: () => live,
    getSession: () => null,
    pauseEngine: () => {},
    resumeEngine: () => {},
    pauseWalkthrough: () => {},
    resumeWalkthrough: () => {},
    storage,
  });
  return {
    map,
    state,
    setGame(game) {
      live = game;
    },
    async boot(game) {
      live = game;
      state.phase = "running";
      await nextTick();
    },
    async eject() {
      state.phase = "idle";
      await nextTick();
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
  };
}

function mapStorage(): {
  storage: Pick<Storage, "getItem" | "setItem">;
  values: Map<string, string>;
  writeAttempts: () => number;
  failWrites(): void;
  allowWrites(): void;
} {
  const values = new Map<string, string>();
  let writing = true;
  let writes = 0;
  return {
    values,
    writeAttempts: () => writes,
    failWrites: () => {
      writing = false;
    },
    allowWrites: () => {
      writing = true;
    },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        writes++;
        if (!writing) throw new DOMException("quota", "QuotaExceededError");
        values.set(key, value);
      },
    },
  };
}

const REV = testRevision("rev-1");
const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

function installedGame(folder: string, hash = "shared-bytes-hash"): BootedGame {
  return { installed: true, title: folder, revision: REV, files: {}, words: [], folder, hash };
}

function savedGame(id: string, epoch: string | null): BootedGame {
  return {
    installed: false,
    title: id,
    revision: REV,
    files: {},
    words: [],
    projectId: testProjectId(id),
    historyLifetime: epoch,
  };
}

function journalRooms(raw: string): number[] {
  return (JSON.parse(raw) as { journal: { to: number }[] }).journal.map((e) => e.to);
}

test("two installed folders sharing one resource hash keep distinct maps", async () => {
  const { storage, values } = mapStorage();
  // Neither folder spelling is a ProjectId: released keys fell back to the
  // shared content hash and the two instances collided on one map record.
  const folderA = "Games/First Quest";
  const folderB = "games/first quest";
  const keyA = mapKey(installedProgressLocator(folderA, REV)!);
  const keyB = mapKey(installedProgressLocator(folderB, REV)!);
  assert.notEqual(keyA, keyB);

  const a = makeHarness(storage);
  await a.boot(installedGame(folderA));
  a.notice({ to: 2, cause: "boot" });
  await nextTick();
  assert.ok(values.has(keyA), "folder A's map stores under its own folder digest");
  assert.equal(values.has(keyB), false);

  const b = makeHarness(storage);
  await b.boot(installedGame(folderB));
  assert.equal(b.map.journal.length, 0, "the same-hash folder borrows no map");
  b.notice({ to: 7, cause: "boot" });
  await nextTick();
  assert.deepEqual(journalRooms(values.get(keyA)!), [2]);
  assert.deepEqual(journalRooms(values.get(keyB)!), [7]);
});

test("an installed instance and a saved project sharing an id keep separate maps", async () => {
  const { storage, values } = mapStorage();
  const installed = makeHarness(storage);
  await installed.boot(installedGame("shared-id"));
  installed.notice({ to: 3, cause: "boot" });
  await nextTick();

  const saved = makeHarness(storage);
  await saved.boot(savedGame("shared-id", EPOCH_A));
  assert.equal(
    saved.map.journal.length,
    0,
    "the saved body does not inherit the installed instance's map",
  );
  saved.notice({ to: 9, cause: "boot" });
  await nextTick();

  const installedKey = mapKey(installedProgressLocator("shared-id", REV)!);
  const projectKey = mapKey(`project:shared-id:${EPOCH_A}`);
  assert.deepEqual(journalRooms(values.get(installedKey)!), [3]);
  assert.deepEqual(journalRooms(values.get(projectKey)!), [9]);
});

test("a recreated saved body gets a fresh map and the stale target cannot follow it", async () => {
  const { storage, values, writeAttempts } = mapStorage();
  const h = makeHarness(storage);
  const oldKey = mapKey(`project:recreated:${EPOCH_A}`);
  const newKey = mapKey(`project:recreated:${EPOCH_B}`);

  await h.boot(savedGame("recreated", EPOCH_A));
  h.notice({ to: 4, cause: "boot" });
  await nextTick();
  assert.deepEqual(journalRooms(values.get(oldKey)!), [4]);

  // The body is deleted and recreated mid-session: the live object already
  // resolves to the new epoch while the map still belongs to the old body.
  h.setGame(savedGame("recreated", EPOCH_B));
  h.notice({ to: 5, cause: "logic" });
  await nextTick();
  assert.equal(values.has(newKey), false, "a queued write must not land under the recreated body");
  assert.deepEqual(journalRooms(values.get(oldKey)!), [4], "the stale write never landed");
  const attempts = writeAttempts();

  // The swap completes through the normal phase path: the recreated body
  // loads its own map — empty, never the removed body's journal.
  await h.eject();
  await h.boot(savedGame("recreated", EPOCH_B));
  assert.equal(h.map.journal.length, 0);
  h.notice({ to: 6, cause: "boot" });
  await nextTick();
  assert.deepEqual(journalRooms(values.get(newKey)!), [6]);
  assert.ok(writeAttempts() > attempts, "the new body's own writes still land");
});

test("a saved game whose body epoch was never captured has no write authority", async () => {
  const { storage, values } = mapStorage();
  const h = makeHarness(storage);
  // The body's first save failed at boot: a null lifetime names no body.
  await h.boot(savedGame("unstored", null));
  h.notice({ to: 3, cause: "boot" });
  await nextTick();
  h.map.setNote(3, "in-memory only");
  assert.equal(values.size, 0);
  assert.equal(h.map.noteFor(3), "in-memory only", "the session map still works");
});

test("a queued retry refused mid-swap never lands under the incoming game", async () => {
  const { storage, values, writeAttempts, failWrites, allowWrites } = mapStorage();
  const h = makeHarness(storage);
  const keyA = mapKey(installedProgressLocator("Games/Swap A", REV)!);
  const keyB = mapKey(installedProgressLocator("Games/Swap B", REV)!);

  await h.boot(installedGame("Games/Swap A"));
  failWrites();
  h.notice({ to: 4, cause: "boot" });
  await nextTick();
  assert.equal(h.map.unsaved.value, true);

  // Another game owns the slot before the map's retry fires.
  h.setGame(installedGame("Games/Swap B"));
  const before = writeAttempts();
  h.map.retrySave();
  assert.equal(writeAttempts(), before, "the queued write refused: the slot moved");
  assert.equal(values.has(keyA), false);
  assert.equal(values.has(keyB), false);
  assert.equal(h.map.unsaved.value, true, "still honestly unsaved");

  allowWrites();
  // The swap completes through the normal path: A's outgoing map flushes
  // under its own locator, B's session starts fresh under its own.
  await h.eject();
  await h.boot(installedGame("Games/Swap B"));
  assert.equal(h.map.journal.length, 0);
  assert.deepEqual(journalRooms(values.get(keyA)!), [4]);
});
