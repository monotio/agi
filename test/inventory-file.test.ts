import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { MESSAGE_KEY } from "../src/logic/resource.ts";
import { readInventoryObjects, validateRoomInventory } from "../src/agent/inventory.ts";
import { buildObjectFile, createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
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

test("the 2.001 two-byte header table drives inventory without an object-index byte", () => {
  // Observed 2.001 layout (docs/fidelity.md pc-booter-inventory-file): u16le
  // item table size, then (nameOffset u16le, location u8) entries, then the
  // name pool at 2 + tableSize. No maximum-drawable-object-index byte.
  const OBJECT_2001 = Uint8Array.of(
    6,
    0, // two entries
    6,
    0,
    255, // item 0: pool offset 0, carried
    9,
    0,
    10, // item 1: pool offset 3, room 10
    0x4b,
    0x45,
    0x59,
    0,
    0x41,
    0x58,
    0x45,
    0, // "KEY", "AXE"
  );
  const files = new Map(createContainer().files);
  files.set("OBJECT", OBJECT_2001);
  const container = openContainer(files);
  container.putResource(
    "logic",
    0,
    assembleLogic("status(); return;", {
      dictionary: new Map(),
      profile: PROFILES["2.001"],
    }).payload,
  );
  const host = new Host();
  const engine = new Engine(container, host, undefined, { profile: "2.001" });
  engine.tick();
  assert.deepEqual(host.statusItems, [{ num: 0, name: "KEY" }]);
});

test("authoring over a plain v3 stub keeps the decoded object-record capacity", () => {
  const profile = PROFILES["3.002.102"];
  const replacement = buildObjectFile([{ name: "?", startingRoom: 0 }], profile, 15);
  assert.notEqual(replacement[2], PLAIN_STUB[2], "the replacement is stored encrypted");
  assert.doesNotThrow(() => validateRoomInventory(PLAIN_STUB, replacement, profile));
  assert.throws(
    () =>
      validateRoomInventory(
        PLAIN_STUB,
        buildObjectFile([{ name: "?", startingRoom: 0 }], profile, 16),
        profile,
      ),
    /Keep existing inventory entries/,
  );
  const state = createAgentSessionState(
    openContainer(
      new Map([
        ["AGIDATA.OVL", Uint8Array.from("Version 3.002.102", (c) => c.charCodeAt(0))],
        ["OBJECT", PLAIN_STUB],
      ]),
    ),
  );
  assert.equal(state.profile.id, "3.002.102");
  const result = executeAgentTool(state, "write_inventory_objects", {
    objects: [
      { name: "?", startingRoom: 0 },
      { name: "lamp", startingRoom: 3 },
    ],
  });
  assert.equal(result.success, true, result.error ?? "tool failed");
  const written = state.getFiles().get("OBJECT")!;
  assert.equal(decodeInventoryFile(written, profile)[2], 15, "index 15 survives the rewrite");
  assert.deepEqual(readInventoryObjects(written, profile), [
    { name: "?", startingRoom: 0 },
    { name: "lamp", startingRoom: 3 },
  ]);
});

test("a long name pool cannot make an impossible decoded item count win", () => {
  const plain = new Uint8Array(31000);
  plain.set([6, 0, 15, 6, 0, 0, 6, 0, 1]);
  plain.fill(65, 9, plain.length - 1);
  const encrypted = plain.map((b, i) => b ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length));
  // 0x7647 is divisible by three and fits the file, but describes 10093 items.
  assert.equal(inventoryTableFits(encrypted), false);
  assert.equal(decodeInventoryFile(plain, PROFILES["3.002.102"])[0], 6);
  const items = readInventoryObjects(plain, PROFILES["3.002.102"]);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.name.length, plain.length - 10);
});
