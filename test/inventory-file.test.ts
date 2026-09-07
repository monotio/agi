import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { MESSAGE_KEY } from "../src/logic/resource.ts";
import { readInventoryObjects } from "../src/agent/inventory.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { decodeInventoryFile, inventoryTableFits } from "../src/runtime/inventoryFile.ts";
import { PROFILES } from "../src/runtime/profile.ts";

// OBJECT metadata: one item "?" in room 0, 16 drawable-object records. This is
// the eight-byte plain stub an observed 3.002.102 demo installation ships next
// to an interpreter whose profile expects the key transform.
const PLAIN_STUB = Uint8Array.of(3, 0, 15, 3, 0, 0, 0x3f, 0);
const ENCRYPTED_STUB = PLAIN_STUB.map((b, i) => b ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length));

class Host implements EngineHost {
  statusItems: { num: number; name: string }[] | null = null;
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  statusScreen(items: { num: number; name: string }[]): void {
    this.statusItems = items;
  }
}

test("the profile's storage rule decodes a file whose table fits", () => {
  assert.deepEqual(decodeInventoryFile(ENCRYPTED_STUB, PROFILES["3.002.102"]), PLAIN_STUB);
  assert.deepEqual(decodeInventoryFile(PLAIN_STUB, PROFILES["2.089"]), PLAIN_STUB);
  assert.equal(inventoryTableFits(PLAIN_STUB), true);
  // Key bytes in the size field: 0x03^0x41, 0x00^0x76 => 0x7642, not a table.
  assert.equal(inventoryTableFits(ENCRYPTED_STUB), false);
});

test("a plain stub next to a later interpreter is read plain, and vice versa", () => {
  assert.deepEqual(decodeInventoryFile(PLAIN_STUB, PROFILES["3.002.102"]), PLAIN_STUB);
  assert.deepEqual(decodeInventoryFile(PLAIN_STUB, PROFILES["2.936"]), PLAIN_STUB);
  assert.deepEqual(decodeInventoryFile(ENCRYPTED_STUB, PROFILES["2.089"]), PLAIN_STUB);
  assert.deepEqual(readInventoryObjects(PLAIN_STUB, PROFILES["3.002.102"]), [
    { name: "?", startingRoom: 0 },
  ]);
});

test("neither reading fitting keeps the profile's reading for the parser to reject", () => {
  const garbage = Uint8Array.of(7, 0, 1, 9, 9, 9);
  assert.deepEqual(decodeInventoryFile(garbage, PROFILES["2.089"]), garbage);
  assert.throws(() => readInventoryObjects(garbage, PROFILES["2.089"]), /Invalid inventory table/);
});

test("the engine lists the stub's single item under a v3 profile", () => {
  const files = new Map(createContainer().files);
  files.set("OBJECT", PLAIN_STUB);
  const container = openContainer(files);
  container.putResource(
    "logic",
    0,
    assembleLogic("get(0); status(); return;", {
      dictionary: new Map(),
      profile: PROFILES["3.002.102"],
    }).payload,
  );
  const host = new Host();
  const engine = new Engine(container, host, undefined, { profile: "3.002.102" });
  engine.tick();
  assert.deepEqual(host.statusItems, [{ num: 0, name: "?" }]);
});
