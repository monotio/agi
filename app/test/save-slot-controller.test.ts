import test from "node:test";
import assert from "node:assert/strict";
import { useSaveSlotController } from "../src/saves/useSaveSlotController.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { testProjectId } from "./identity.ts";

function createMockStorage(): Pick<Storage, "getItem" | "setItem"> {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
  };
}

test("released numbered saves remain restorable and survive the first bound save", async () => {
  const storage = createMockStorage();
  const game: BootedGame = {
    installed: false,
    projectId: testProjectId("released-slots"),
    title: "Released",
    revision: requireResourceRevision("ab".repeat(32)),
    historyLifetime: "initial",
    files: {},
    words: [],
  };
  const original = btoa("a released save image padded to forty characters");
  const raw = JSON.stringify({ format: "monotio.agi.saves", version: 1, slots: { "1": original } });
  storage.setItem("monotio_agi.saves.released-slots", raw);
  const controller = useSaveSlotController({ storage, getBootedGame: () => game });
  assert.equal(await controller.handleSaveSlotRequest("restore", { slot: 1 }), original);
  assert.equal(
    controller.handleSaveSlotRequest("saveWrite", { slot: 2, image: btoa("new image") }),
    "true",
  );
  assert.equal(await controller.handleSaveSlotRequest("restore", { slot: 1 }), original);
  assert.equal(storage.getItem("monotio_agi.saves.released-slots"), raw);
});

test("useSaveSlotController handles saveList, saveWrite, and restore lifecycle", async () => {
  const storage = createMockStorage();
  let booted: BootedGame | null = null;
  const logs: Array<{ level: string; msg: string }> = [];

  const controller = useSaveSlotController({
    getBootedGame: () => booted,
    logAgent: (level, msg) => logs.push({ level, msg }),
    storage,
  });

  // saveList when not booted returns empty list
  assert.equal(controller.handleSaveSlotRequest("saveList", {}), "[]");

  // restore when not booted returns empty string
  const emptyRestore = await controller.handleSaveSlotRequest("restore", { slot: 1 });
  assert.equal(emptyRestore, "");
  assert.equal(
    logs.some((l) => l.msg.includes("No saved game found")),
    true,
  );

  // Boot an installed game: its folder and full revision bind the target.
  booted = {
    installed: true,
    folder: "test-folder",
    hash: "test-hash-1234",
    title: "Test Game",
    revision: requireResourceRevision("ab".repeat(32)),
  } as BootedGame;

  // Initially empty save list
  assert.equal(controller.handleSaveSlotRequest("saveList", {}), "[]");

  // Save to slot 1: image must be base64 string
  const testPayload = btoa("0123456789012345678901234567890123456789extra-data-after-40-bytes");
  const writeRes = controller.handleSaveSlotRequest("saveWrite", { slot: 1, image: testPayload });
  assert.equal(writeRes, "true");

  // Listing saves returns truncated 40-byte image
  const listJson = controller.handleSaveSlotRequest("saveList", {}) as string;
  const list = JSON.parse(listJson) as Array<{ slot: number; image: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.slot, 1);
  assert.equal(atob(list[0]?.image ?? ""), "0123456789012345678901234567890123456789");

  // Restore returns full payload
  const restored = await controller.handleSaveSlotRequest("restore", { slot: 1 });
  assert.equal(restored, testPayload);

  // An authored project binds its id to the live body epoch captured at boot.
  booted = {
    installed: false,
    projectId: "project-alpha",
    title: "Authored Game",
    revision: requireResourceRevision("cd".repeat(32)),
    historyLifetime: "initial",
  } as BootedGame;

  // Different game namespace: initially empty
  assert.equal(controller.handleSaveSlotRequest("saveList", {}), "[]");

  const authoredPayload = btoa("authored-save-content-padded-to-over-forty-characters-here");
  const writeAuthored = controller.handleSaveSlotRequest("saveWrite", {
    slot: 2,
    image: authoredPayload,
  });
  assert.equal(writeAuthored, "true");

  const restoredAuthored = await controller.handleSaveSlotRequest("restore", { slot: 2 });
  assert.equal(restoredAuthored, authoredPayload);
});
