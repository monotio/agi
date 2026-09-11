import test from "node:test";
import assert from "node:assert/strict";
import { useSaveSlotController } from "../src/useSaveSlotController.ts";
import type { BootedGame } from "../src/gameTypes.ts";

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

  // Boot an installed game with a content hash
  booted = {
    installed: true,
    hash: "test-hash-1234",
    title: "Test Game",
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

  // Authoring game uses projectId
  booted = {
    installed: false,
    projectId: "project-alpha",
    title: "Authored Game",
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
