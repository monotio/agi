import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyMapSidecar,
  mapArchiveData,
  mapKey,
  MAX_MAP_BYTES,
  readMapArchive,
  readMapSidecar,
  writeMapSidecar,
} from "../src/roomMapStore.ts";
import type { RoomMapSidecar } from "../src/useRoomMap.ts";

function fakeStorage(initial: Record<string, string> = {}): {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  values: Map<string, string>;
  failWrites: () => void;
  allowWrites: () => void;
} {
  const values = new Map(Object.entries(initial));
  let writing = true;
  return {
    values,
    failWrites: () => {
      writing = false;
    },
    allowWrites: () => {
      writing = true;
    },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (!writing) throw new DOMException("quota", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  };
}

const sidecar: RoomMapSidecar = {
  journal: [
    {
      seq: 1,
      session: 1,
      from: null,
      to: 0,
      cause: "boot",
      cycle: 3,
      resourceSet: "rev-1@0",
      scoreDelta: 0,
      gained: [],
      lost: [],
    },
    {
      seq: 2,
      session: 1,
      from: 0,
      to: 2,
      cause: "edge",
      edge: "right",
      cycle: 40,
      resourceSet: "rev-1@0",
      scoreDelta: 3,
      gained: [4],
      lost: [1],
    },
  ],
  layout: { "2": { x: 400, y: -170 } },
  notes: { "2": "check the guard timing" },
};

test("map sidecar round-trips through storage", () => {
  const { storage } = fakeStorage();
  assert.equal(writeMapSidecar(storage, "game-1", sidecar), true);
  assert.deepEqual(readMapSidecar(storage, "game-1"), sidecar);
});

test("a missing sidecar is an empty map, not an error", () => {
  const { storage } = fakeStorage();
  assert.deepEqual(readMapSidecar(storage, "never-saved"), emptyMapSidecar());
});

test("corrupt and unsupported sidecars throw a readable error", () => {
  const { storage } = fakeStorage({ [mapKey("bad-json")]: "{not json" });
  assert.throws(() => readMapSidecar(storage, "bad-json"), /corrupt/);

  const { storage: versioned } = fakeStorage({
    [mapKey("old")]: JSON.stringify({ format: "monotio.agi.map", version: 99, journal: [] }),
  });
  assert.throws(() => readMapSidecar(versioned, "old"), /not readable|version/i);

  const { storage: huge } = fakeStorage({
    [mapKey("huge")]: "x".repeat(MAX_MAP_BYTES + 1),
  });
  assert.throws(() => readMapSidecar(huge, "huge"), /too large/);
});

test("storage refusal reports false and leaves the record alone", () => {
  const { storage, values, failWrites, allowWrites } = fakeStorage();
  assert.equal(writeMapSidecar(storage, "game-1", sidecar), true);
  const before = values.get(mapKey("game-1"));
  failWrites();
  assert.equal(writeMapSidecar(storage, "game-1", emptyMapSidecar()), false);
  assert.equal(values.get(mapKey("game-1")), before);
  allowWrites();
  assert.equal(writeMapSidecar(storage, "game-1", emptyMapSidecar()), true);
  assert.deepEqual(readMapSidecar(storage, "game-1"), emptyMapSidecar());
});

test("MAP.JSON archive bytes round-trip and reject garbage", () => {
  const bytes = new TextEncoder().encode(mapArchiveData(sidecar));
  assert.deepEqual(readMapArchive(bytes), sidecar);
  assert.throws(() => readMapArchive(new TextEncoder().encode("[]")), /not map data/);
  assert.throws(() => readMapArchive(new TextEncoder().encode("not json")), /invalid JSON/);
  assert.throws(() => readMapArchive(new Uint8Array(MAX_MAP_BYTES + 1)), /too large/);
});
