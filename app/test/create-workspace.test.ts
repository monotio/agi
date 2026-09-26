import assert from "node:assert/strict";
import { test } from "node:test";
import { ref } from "vue";
import { registerCreatePanel } from "../src/shell/createDocks.ts";
import {
  createCreateWorkspace,
  DOCKS_STORAGE_KEY,
  type StudioRequest,
} from "../src/shell/useCreateWorkspace.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { testRevision } from "./identity.ts";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function workspace(storage: Pick<Storage, "getItem" | "setItem">) {
  const calls: string[] = [];
  const ws = createCreateWorkspace({
    pauseEngine: (owner) => calls.push(`pause:${owner}`),
    resumeEngine: (owner) => calls.push(`resume:${owner}`),
    focusGame: () => calls.push("focus"),
    storage,
  });
  return { ws, calls };
}

test("a folded dock is remembered per viewer and survives unreadable storage", () => {
  const storage = memoryStorage();
  const { ws } = workspace(storage);
  assert.deepEqual({ ...ws.collapsed }, { left: false, right: false });
  ws.toggleDock("left");
  assert.equal(storage.data.get(DOCKS_STORAGE_KEY), '{"left":true,"right":false}');
  // The next page load reads it back.
  assert.equal(workspace(storage).ws.collapsed.left, true);
  // Corrupt text or a throwing store leaves both docks open, and a refused
  // write still folds the dock for this page.
  assert.deepEqual(
    { ...workspace(memoryStorage({ [DOCKS_STORAGE_KEY]: "{oops" })).ws.collapsed },
    { left: false, right: false },
  );
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  const { ws: fallback } = workspace(blocked);
  assert.equal(fallback.collapsed.right, false);
  fallback.toggleDock("right");
  assert.equal(fallback.collapsed.right, true);
});

test("showing a panel selects its tab and unfolds its dock", () => {
  const off = registerCreatePanel({ id: "inspect", dock: "right", title: "Inspect", order: 1 });
  try {
    const storage = memoryStorage({ [DOCKS_STORAGE_KEY]: '{"left":false,"right":true}' });
    const { ws } = workspace(storage);
    ws.showPanel("inspect");
    assert.equal(ws.active.right, "inspect");
    assert.equal(ws.active.left, "world");
    assert.equal(ws.collapsed.right, false);
    assert.equal(ws.active.sheet, "inspect");
  } finally {
    off();
  }
});

function studioRequest(
  room: number,
  reload: () => StudioRequest | null = () => null,
): StudioRequest {
  return {
    room,
    pictureNumber: 5,
    bytes: Uint8Array.of(0xff),
    profile: Object.values(PROFILES)[0]!,
    title: `Room ${room}`,
    baseRevision: testRevision("studio"),
    reload,
  };
}

test("Studio holds its own pause and hands the keyboard back on close", () => {
  const { ws, calls } = workspace(memoryStorage());
  const request = studioRequest(2);
  ws.openStudio(request);
  ws.openStudio({ ...request, pictureNumber: 6 });
  assert.equal(ws.studio.value?.pictureNumber, 6);
  ws.closeStudio();
  ws.closeStudio();
  assert.equal(ws.studio.value, null);
  assert.deepEqual(calls, ["pause:studio", "resume:studio", "focus"]);
});

test("reopening Studio reads its picture again under the same pause, or closes when it is gone", () => {
  const { ws, calls } = workspace(memoryStorage());
  const fresh = { ...studioRequest(2), baseRevision: testRevision("after") };
  ws.openStudio(studioRequest(2, () => fresh));
  ws.reopenStudio();
  assert.equal(ws.studio.value, fresh);
  assert.deepEqual(calls, ["pause:studio"]);
  ws.reopenStudio();
  assert.equal(ws.studio.value, null, "the fresh request's reload finds nothing");
  assert.deepEqual(calls, ["pause:studio", "resume:studio", "focus"]);
});

test("Studio never opens where it does not fit, and holds no pause there", () => {
  const calls: string[] = [];
  const fits = ref(false);
  const ws = createCreateWorkspace({
    pauseEngine: (owner) => calls.push(`pause:${owner}`),
    resumeEngine: (owner) => calls.push(`resume:${owner}`),
    focusGame: () => calls.push("focus"),
    studioFits: () => fits.value,
    storage: memoryStorage(),
  });
  const request = studioRequest(1);
  assert.equal(ws.studioFits.value, false);
  ws.openStudio(request);
  assert.equal(ws.studio.value, null);
  assert.deepEqual(calls, []);
  fits.value = true;
  ws.openStudio(request);
  assert.equal(ws.studio.value, request);
  assert.deepEqual(calls, ["pause:studio"]);
});
