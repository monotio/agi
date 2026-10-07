import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleLogic } from "../src/logic/assembler.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { compileProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { openContainer } from "../src/container/container.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import {
  FIRST_ROOM_LOGIC_SOURCE,
  FIRST_ROOM_PICTURE_SOURCE,
  FIRST_STARTUP_LOGIC0_SOURCE,
  firstRoomChanges,
} from "../src/authoring/firstRoom.ts";

/**
 * The blank game's first room: Room 1 with a blank white PICTURE and a few
 * lines of LOGIC that show it, plus a minimal readable Start-up LOGIC 0 that
 * enters Room 1. No hero, menus, game over, flags, sound or LOGIC 255; the
 * bindings stay empty so Game state stays empty until the creator names
 * something.
 *
 * The expected code bytes below are derived by hand from src/logic/opcodes.ts
 * and the assembler's framing rules: an if is `ff <conds> ff s16` where the
 * little-endian delta skips the then-block. If the sources change, re-derive
 * the tables, never copy assembler output.
 */

const PROFILE = PROFILES["2.936"]!;
const DICT = new Map<string, number>();

// fmt: off — every run is one source statement, annotated.
const EXPECTED_STARTUP_CODE: number[] = [
  // if (equaln(v0, 0)) { new.room(1); } — ff, equaln v0 0, ff, delta over 2 bytes
  0xff,
  0x01,
  0x00,
  0x00,
  0xff,
  0x02,
  0x00,
  0x12,
  0x01, // new.room(1)
  0x17,
  0x00, // call.v(v0)
  0x00, // return
];

const EXPECTED_ROOM_CODE: number[] = [
  // if (isset(f5)) { ... } — ff, isset f5, ff, delta over 9 bytes
  0xff,
  0x07,
  0x05,
  0xff,
  0x09,
  0x00,
  0x03,
  0x32,
  0x01, // assignn(v50, 1)
  0x18,
  0x32, // load.pic(v50)
  0x19,
  0x32, // draw.pic(v50)
  0x1a, // show.pic()
  0x78, // accept.input()
  0x00, // return
];
// fmt: on

class FirstRoomHost implements EngineHost {
  waitKey(): number {
    throw new HostWait();
  }
  takeKeys(): number[] {
    return [];
  }
  takeInputLine(): string | null {
    return null;
  }
  playSound(): void {}
  soundOutput(): void {}
  saveGame(): boolean {
    return false;
  }
  restoreGame(): Uint8Array | null {
    return null;
  }
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
}

function buildFirstRoom() {
  const blank = createStarterProject("blank");
  const documents = Object.fromEntries(
    firstRoomChanges().map((change) => [change.key, change.content!]),
  );
  const result = compileProjectDocuments({
    files: Object.fromEntries(blank.files()),
    documents,
    profileId: "2.936",
  });
  assert.ok(result.build, "the first room documents must compile");
  return { documents, files: result.build.files() };
}

describe("first room on a blank game", () => {
  test("the Start-up LOGIC 0 compiles to the hand-derived bytes", () => {
    const r = assembleLogic(FIRST_STARTUP_LOGIC0_SOURCE, { dictionary: DICT, profile: PROFILE });
    assert.deepEqual([...r.code], EXPECTED_STARTUP_CODE);
    assert.deepEqual(r.messages, [""], "the minimal start-up has no messages");
  });

  test("the room LOGIC compiles to the hand-derived bytes", () => {
    const r = assembleLogic(FIRST_ROOM_LOGIC_SOURCE, { dictionary: DICT, profile: PROFILE });
    assert.deepEqual([...r.code], EXPECTED_ROOM_CODE);
    assert.deepEqual(r.messages, [""], "the empty room has no messages");
  });

  test("the blank white PICTURE is a single end byte", () => {
    const r = compilePictureSource(FIRST_ROOM_PICTURE_SOURCE, { profile: PROFILE });
    assert.deepEqual([...r.bytes], [0xff]);
  });

  test("adds exactly the first room's documents: no hero, menus, game over, flags or sound", () => {
    const { documents } = buildFirstRoom();
    assert.deepEqual(Object.keys(documents).sort(), [
      "bindings",
      "inventory",
      "logic:0",
      "logic:1",
      "picture:1",
      "words",
      "world",
    ]);
    assert.equal(documents["bindings"], "{}", "Game state stays empty");
    const world = JSON.parse(String(documents["world"]));
    assert.deepEqual(world.rooms, {
      "1": { title: "Room 1", titleIsDefault: true, description: "", exits: {} },
    });
  });

  test("the built game holds no LOGIC 255, SOUND or VIEW resources", () => {
    const { files } = buildFirstRoom();
    const container = openContainer(files, { profile: PROFILE });
    assert.equal(container.getResource("logic", 255), null);
    assert.equal(container.getResource("sound", 255), null);
    assert.equal(container.getResource("view", 0), null);
    assert.ok(container.getResource("logic", 0), "LOGIC 0 exists so the game can start");
    assert.ok(container.getResource("logic", 1));
    assert.ok(container.getResource("picture", 1));
  });

  test("the engine boots into Room 1, shows its picture and accepts input", () => {
    const { files } = buildFirstRoom();
    const container = openContainer(files, { profile: PROFILE });
    const engine = new Engine(container, new FirstRoomHost(), DICT);
    engine.tick();
    assert.equal(engine.vars[0], 1, "the start-up entered Room 1");
    engine.tick();
    assert.equal(engine.vars[0], 1);
    assert.equal(engine.vars[50], 1, "the room's entry block ran and read its picture number");
    assert.equal(engine.flags[5], 0, "the new-room flag cleared after the entry cycle");
  });

  test("a room added later runs through the same Start-up without registration", () => {
    const { documents } = buildFirstRoom();
    documents["logic:2"] = "if (isset(f5)) {\n  assignn(v51, 7);\n}\nreturn;\n";
    const blank = createStarterProject("blank");
    const result = compileProjectDocuments({
      files: Object.fromEntries(blank.files()),
      documents,
      profileId: "2.936",
    });
    assert.ok(result.build);
    const container = openContainer(result.build.files(), { profile: PROFILE });
    const engine = new Engine(container, new FirstRoomHost(), DICT);
    engine.tick();
    assert.equal(engine.vars[0], 1);
    // Room 1 walks into Room 2 the way a drawn door does: new.room unwinds,
    // and the next cycle's call.v(v0) runs LOGIC 2 with no registration.
    engine.reenterRoom(2);
    engine.tick();
    assert.equal(engine.vars[0], 2);
    assert.equal(engine.vars[1], 1, "the previous room is recorded");
    assert.equal(engine.vars[51], 7, "LOGIC 2's entry block ran");
  });
});
