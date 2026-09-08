import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  type AgiProfile,
  PROFILES,
  detectProfile,
  detectVersionString,
  findVersionString,
} from "../src/runtime/profile.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine, UnimplementedOpcodeError, type EngineHost } from "../src/runtime/engine.ts";

/**
 * Interpreter version profiles (spec "Version Profiles" and the conformance
 * matrix's profile-variant tables), profile detection from an installed game
 * folder, and the engine paths that select behavior by profile field.
 *
 * Every expectation below is read off the spec tables by hand and cited in a
 * comment; nothing here is snapshotted from the implementation.
 */

const DICT = new Map<string, number>();

// version_profiles.md, 3.002.149: the documented room-alias variant maps
// immediate destinations 0x7e..0x80 to 0x49. Exercise it as an explicit override.
const ROOM_ALIAS_PROFILE: AgiProfile = {
  ...PROFILES["3.002.149"],
  roomAliases: new Map([
    [0x7e, 0x49],
    [0x7f, 0x49],
    [0x80, 0x49],
  ]),
};

class Host implements EngineHost {
  keys: number[] = [];
  printed: string[] = [];
  print(text: string): void {
    this.printed.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

function boot(
  source: string,
  profile?: Parameters<typeof detectProfile>[1],
  extra?: (c: ReturnType<typeof createContainer>) => void,
): { engine: Engine; host: Host } {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: DICT }).payload);
  extra?.(container);
  const host = new Host();
  const engine = new Engine(container, host, DICT, profile === undefined ? undefined : { profile });
  engine.tick();
  return { engine, host };
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

describe("profile table", () => {
  // version_profiles.md "AGI 2.936 profile" and the conformance matrix
  // two-column tables: actions 0x00..0xaf, twelve string slots, 39 key-map
  // entries, 0xad increments, 0xa3/0xa4 keep their effect, four-or-more loops
  // use the direction table without f20.
  test("2.936 is the split-container baseline", () => {
    const p = PROFILES["2.936"];
    assert.equal(p.container, "v2-split");
    assert.equal(p.volumeHeaderBytes, 5);
    assert.equal(p.maxAction, 0xaf);
    assert.equal(p.maxCondition, 0x12);
    assert.equal(p.stringSlots, 12);
    assert.equal(p.keyMapCapacity, 39);
    assert.equal(p.releaseGateAction, "increment");
    assert.equal(p.inputWidthActions, "effect");
    assert.equal(p.closeWindowClearsInputWidth, true);
    assert.equal(p.directionLoops, "four-or-more");
    assert.equal(p.directionLoopTiming, "cadence-due");
    assert.equal(p.pictureMaxCommand, 0xfa);
    assert.equal(p.patternProfile, "shaped-v2");
    assert.equal(p.roomAliases, null);
    assert.equal(p.saveBlocks, 5);
    assert.equal(p.saveBlock3Xor, false);
  });

  // version_profiles.md "AGI 3.002.149 profile": range through 0xb5, 49 key-map
  // entries, 0xad sets the gate, 0xb5 clears it, 0xa3/0xa4 have no effect,
  // >4 loops need f20, block 3 is XOR-transformed, combined v3 container.
  test("3.002.149 records every v3 variant", () => {
    const p = PROFILES["3.002.149"];
    assert.equal(p.container, "v3-combined");
    assert.equal(p.volumeHeaderBytes, 7);
    assert.equal(p.maxAction, 0xb5);
    assert.equal(p.extraActions, "v3-full");
    assert.equal(p.keyMapCapacity, 49);
    assert.equal(p.releaseGateAction, "set");
    assert.equal(p.releaseGateClearAction, true);
    assert.equal(p.inputWidthActions, "noop");
    assert.equal(p.closeWindowClearsInputWidth, false);
    assert.equal(p.directionLoops, "four-or-more-f20");
    assert.equal(p.menuInteractionGate, true);
    assert.equal(p.patternProfile, "v3-center-row");
    assert.equal(p.saveBlock3Xor, true);
    assert.equal(p.roomAliases, null);
  });

  // Conformance matrix "2.089 variant selection": actions end at 0x9a, 0x86
  // takes no operand, six string slots, no 0x270f tail terminator, pictures
  // dispatch only through 0xf8, earlier partition in object-number order,
  // four save blocks, expanded (plain) inventory metadata.
  test("2.089 is the earliest promoted profile", () => {
    const p = PROFILES["2.089"];
    assert.equal(p.maxAction, 0x9a);
    assert.equal(p.exitOperandBytes, 0);
    assert.equal(p.exitAlwaysImmediate, true);
    assert.equal(p.menuActions, "none");
    assert.equal(p.stringSlots, 6);
    assert.equal(p.wordSequenceTailTerminator, false);
    assert.equal(p.pictureMaxCommand, 0xf8);
    assert.equal(p.patternProfile, "none");
    assert.equal(p.positionActionOrder, "erase-then-store");
    assert.equal(p.earlierPartitionOrder, "object-number");
    assert.equal(p.directionLoops, "exact-four");
    assert.equal(p.directionLoopTiming, "every-pass");
    assert.equal(p.saveBlocks, 4);
    assert.equal(p.inventoryMetadataEncrypted, false);
    assert.equal(p.sound, "early-2.089");
  });

  // Conformance matrix "2.230 variant selection": same ranges as 2.089, but
  // 0x270f terminates a word sequence, both partitions sort by drawing key,
  // position actions store together, and the loop header is packed.
  test("2.230 keeps the 2.089 ranges with the packed loop header", () => {
    const p = PROFILES["2.230"];
    assert.equal(p.maxAction, 0x9a);
    assert.equal(p.exitOperandBytes, 0);
    assert.equal(p.stringSlots, 6);
    assert.equal(p.wordSequenceTailTerminator, true);
    assert.equal(p.packedViewLoopHeader, true);
    assert.equal(p.positionActionOrder, "store-together");
    assert.equal(p.earlierPartitionOrder, "drawing-key");
    assert.equal(p.saveBlocks, 5);
  });

  // Conformance matrix "2.272 variant selection": actions 0x00..0xa0, 0x86
  // consumes a selector, 0x9b..0xa0 parse without constructing a menu.
  test("2.272 parses menu bytecode without menus", () => {
    const p = PROFILES["2.272"];
    assert.equal(p.maxAction, 0xa0);
    assert.equal(p.exitOperandBytes, 1);
    assert.equal(p.exitAlwaysImmediate, false);
    assert.equal(p.menuActions, "stub");
    assert.equal(p.stringSlots, 6);
    assert.equal(p.movementClear, "later");
    assert.equal(p.sound, "early-2.272");
  });

  // Conformance matrix "2.411"/"2.440 variant selection": actions end at 0xa9
  // (so 0xad is not exposed), exact-four loop selection, no later heap line;
  // 2.411 always prompts on restart, 2.440 lets f16 bypass it, and 2.411 uses
  // the early point-plot pattern profile.
  test("2.411 and 2.440 differ in restart and pattern behavior", () => {
    const early = PROFILES["2.411"];
    const later = PROFILES["2.440"];
    assert.equal(early.maxAction, 0xa9);
    assert.equal(later.maxAction, 0xa9);
    assert.equal(early.releaseGateAction, "unavailable");
    assert.equal(later.releaseGateAction, "unavailable");
    assert.equal(early.directionLoops, "exact-four");
    assert.equal(later.directionLoops, "exact-four");
    assert.equal(early.heapDiagnosticExtraLine, false);
    assert.equal(later.heapDiagnosticExtraLine, false);
    assert.equal(early.restartPromptBypassedByF16, false);
    assert.equal(later.restartPromptBypassedByF16, true);
    assert.equal(early.patternProfile, "point-2.411");
    assert.equal(later.patternProfile, "shaped-v2");
    assert.equal(early.sound, "early-2.411");
    assert.equal(later.sound, "early-2.440");
  });

  // Conformance matrix "2.917 variant selection": actions end at 0xad
  // (0xae/0xaf invalid) and only exactly-four-loop views select a loop.
  test("2.917 is 2.936 without 0xae/0xaf and without four-or-more loops", () => {
    const p = PROFILES["2.917"];
    assert.equal(p.maxAction, 0xad);
    assert.equal(p.releaseGateAction, "increment");
    assert.equal(p.keyMapCapacity, 39);
    assert.equal(p.directionLoops, "exact-four");
    assert.equal(p.inputWidthActions, "effect");
  });

  // Conformance matrix "3.002.086"/"3.002.102 variant selection".
  test("the other v3 profiles keep 39 key-map entries", () => {
    const p086 = PROFILES["3.002.086"];
    assert.equal(p086.maxAction, 0xb1);
    assert.equal(p086.extraActions, "v3-086");
    assert.equal(p086.keyMapCapacity, 39);
    assert.equal(p086.releaseGateAction, "increment");
    assert.equal(p086.releaseGateClearAction, false);
    assert.equal(p086.directionLoops, "four-or-more");
    assert.equal(p086.clampExactZeroLeftBoundary, true);

    const p102 = PROFILES["3.002.102"];
    assert.equal(p102.maxAction, 0xb5);
    assert.equal(p102.keyMapCapacity, 39);
    assert.equal(p102.releaseGateAction, "set");
    assert.equal(p102.inputWidthActions, "effect");
    assert.equal(p102.closeWindowClearsInputWidth, true);
    assert.equal(p102.directionLoops, "four-or-more-f20");
    assert.equal(p102.roomAliases, null);
  });
});

describe("profile detection", () => {
  const VERSION_BLOB = ascii("Adventure Game Interpreter\n      Version 2.917\0");

  test("finds the interpreter version string in a binary", () => {
    assert.equal(findVersionString(VERSION_BLOB), "2.917");
    assert.equal(findVersionString(ascii("...Version 3.002.149\0rest")), "3.002.149");
    // A longer numeric run must not be truncated into a false match.
    assert.equal(findVersionString(ascii("build 12.936")), null);
    assert.equal(findVersionString(ascii("value 2.9367")), null);
    assert.equal(findVersionString(ascii("no version here")), null);
  });

  test("reads the version from AGIDATA.OVL and selects the promoted profile", () => {
    const files = new Map([
      ["LOGDIR", new Uint8Array(3)],
      ["AGIDATA.OVL", VERSION_BLOB],
    ]);
    assert.equal(detectVersionString(files), "2.917");
    assert.equal(detectProfile(files).id, "2.917");
  });

  test("an observed build selects the promoted profile the spec names", () => {
    // version_profiles.md: the 2.915 build selects the 2.917 rules; the 2.439
    // build selects 2.440; 3.002.107 selects 3.002.102.
    const at = (v: string) =>
      detectProfile(
        new Map([
          ["LOGDIR", new Uint8Array(3)],
          ["AGI", ascii(`Version ${v}\0`)],
        ]),
      ).id;
    assert.equal(at("2.915"), "2.917");
    assert.equal(at("2.439"), "2.440");
    assert.equal(at("3.002.107"), "3.002.102");
    // An unpromoted version falls back to the container shape: similarity to a
    // promoted profile must not be assumed.
    assert.equal(at("2.999"), "2.936");
  });

  test("falls back to the container shape when no interpreter binary is present", () => {
    assert.equal(detectProfile(new Map([["LOGDIR", new Uint8Array(3)]])).id, "2.936");
    const v3 = new Map([
      ["GRDIR", new Uint8Array(3)],
      ["GRVOL.0", new Uint8Array(0)],
    ]);
    assert.equal(detectProfile(v3).id, "3.002.149");
  });

  test("an explicit override wins over the detected version", () => {
    const files = new Map([
      ["LOGDIR", new Uint8Array(3)],
      ["AGIDATA.OVL", VERSION_BLOB],
    ]);
    assert.equal(detectProfile(files, "2.089").id, "2.089");
    assert.equal(detectProfile(files, ROOM_ALIAS_PROFILE), ROOM_ALIAS_PROFILE);
    assert.throws(
      () => detectProfile(files, "1.000" as never),
      /unknown interpreter profile 1\.000/,
    );
  });
});

describe("engine selects behavior by profile field", () => {
  // Action 0xad (spec "Tracked key release"): 2.917/2.936/3.002.086 increment
  // the gate modulo 256; 3.002.102/3.002.149 set it to one.
  const HOLD = `
    hold.key();
    hold.key();
    hold.key();
    return;
  `;

  test("0xad increments under 2.936 and sets to one under 3.002.149", () => {
    assert.equal(boot(HOLD).engine.releaseGate, 3);
    assert.equal(boot(HOLD, "3.002.149").engine.releaseGate, 1);
    assert.equal(boot(HOLD, "3.002.102").engine.releaseGate, 1);
    assert.equal(boot(HOLD, "3.002.086").engine.releaseGate, 3);
  });

  test("0xad is not an action in the 2.411 range", () => {
    // Actions end at 0xa9 in 2.411/2.440, so the byte is not dispatched.
    assert.throws(() => boot(HOLD, "2.411"), UnimplementedOpcodeError);
    assert.throws(() => boot(HOLD, "2.440"), UnimplementedOpcodeError);
  });

  test("the profile action range rejects opcodes above it", () => {
    // 0xae (set.pri.base) is valid in 2.936 but not in 2.917 (range 0x00..0xad).
    const PRI = "set.pri.base(50);\nreturn;\n";
    assert.doesNotThrow(() => boot(PRI));
    assert.throws(() => boot(PRI, "2.917"), UnimplementedOpcodeError);
    // 0x9c (set.menu) is valid in 2.936 but not in 2.230 (range 0x00..0x9a).
    const MENU = 'set.menu("File");\nreturn;\n';
    assert.doesNotThrow(() => boot(MENU));
    assert.throws(() => boot(MENU, "2.230"), UnimplementedOpcodeError);
  });

  test("2.272 parses menu construction without building a menu", () => {
    // 0x9c..0x9e consume their operands in 2.272 but construct nothing, and
    // menu.input (0xa1) is above that profile's 0x00..0xa0 action range.
    const BUILD = `
      set.menu("File");
      set.menu.item("Save", 1);
      submit.menu();
      set(f14);
    `;
    const stub = boot(`${BUILD}\nreturn;\n`, "2.272").engine;
    stub.tick();
    assert.equal(stub.modalKind, null, "2.272 consumes the operands only");
    assert.throws(
      () => boot(`${BUILD}\nmenu.input();\nreturn;\n`, "2.272"),
      UnimplementedOpcodeError,
    );

    const full = boot(`
      if (!isset(f221)) {
        set.menu("File");
        set.menu.item("Save", 1);
        submit.menu();
        set(f14);
        set(f221);
      }
      menu.input();
      return;
    `).engine;
    full.tick();
    assert.equal(full.modalKind, "menu", "2.936 builds and opens the menu");
  });

  test("string slots outside the profile range are ignored", () => {
    const SET = 'set.string(s6, "hi");\nreturn;\n';
    const later = boot(SET).engine;
    assert.equal(later.strings.length, 12);
    assert.equal(later.strings[6], "hi");
    const early = boot(SET, "2.272").engine;
    assert.equal(early.strings.length, 6, "2.089/2.230/2.272 expose s0..s5");
    assert.deepEqual([...early.strings], ["", "", "", "", "", ""]);
  });

  test("0xa3/0xa4 fix the input width in 2.936 and do nothing in 3.002.149", () => {
    // The input row is 40 columns; with no prompt marker the edit buffer holds
    // 39 characters, and open.dialogue caps the fixed width at 36.
    const OPEN = "accept.input();\nopen.dialogue();\nreturn;\n";
    const wide = boot(OPEN, "3.002.149").engine;
    wide.setEditLine("x".repeat(50));
    assert.equal(wide.inputEdit.length, 39);
    const capped = boot(OPEN).engine;
    capped.setEditLine("x".repeat(50));
    assert.equal(capped.inputEdit.length, 36);
    // close.dialogue restores the derived width under 2.936 only.
    const closed = boot("accept.input();\nopen.dialogue();\nclose.dialogue();\nreturn;\n").engine;
    closed.setEditLine("x".repeat(50));
    assert.equal(closed.inputEdit.length, 39);
  });

  test("the script key map stops at the profile capacity", () => {
    // 39 entries in 2.936, 49 in 3.002.149. Map ASCII keys 32..76 in order
    // and press the 40th (71): only 3.002.149 still has room for it.
    // ASCII events carry only the low byte, never an accompanying scan byte.
    const lines: string[] = [];
    for (let i = 0; i < 45; i++) lines.push(`set.key(${i + 32}, 0, ${i + 1});`);
    const source = `${lines.join("\n")}\nreturn;\n`;
    const press = (profileId?: "3.002.149"): number => {
      const { engine, host } = boot(source, profileId);
      host.keys.push(71); // the 40th mapping (index 39)
      engine.tick();
      return engine.controllers[40]!;
    };
    assert.equal(press(), 0, "2.936 accepts only 39 mappings");
    assert.equal(press("3.002.149"), 1, "3.002.149 accepts 49");
  });

  test("immediate room aliases apply only through an explicit profile override", () => {
    const withRooms = (c: ReturnType<typeof createContainer>): void => {
      const empty = assembleLogic("return;\n", { dictionary: DICT }).payload;
      for (const room of [126, 127, 128, 129]) c.putResource("logic", room, empty);
      c.putResource("logic", 73, empty);
    };
    for (const room of [126, 127, 128, 129]) {
      const source = `if (!isset(f220)) { set(f220); new.room(${room}); }\nreturn;\n`;
      assert.equal(boot(source, "3.002.149", withRooms).engine.vars[0], room);
      assert.equal(
        boot(source, ROOM_ALIAS_PROFILE, withRooms).engine.vars[0],
        room <= 128 ? 73 : room,
      );
    }
  });

  test("direction-selected loops follow the profile rule", () => {
    // A five-loop view with 1x1 cels; direction 5 (down) selects loop 2 in the
    // four-or-more table. 2.917 does not select for more than four loops;
    // 3.002.149 requires f20.
    const view = buildView({
      loops: Array.from({ length: 5 }, () => ({ cels: [{ width: 1, height: 1, pixels: [2] }] })),
    });
    const withView = (c: ReturnType<typeof createContainer>): void =>
      c.putResource("view", 1, view);
    const SOURCE = `
      animate.obj(o0);
      load.view(1);
      set.view(o0, 1);
      position(o0, 40, 100);
      draw(o0);
      assignn(v200, 5);
      set.dir(o0, v200);
      return;
    `;
    const loopOf = (profileId?: Parameters<typeof detectProfile>[1], f20 = false): number => {
      const { engine } = boot(SOURCE, profileId, withView);
      if (f20) engine.flags[20] = 1;
      engine.tick();
      return engine.screenObjects[0]!.loop;
    };
    assert.equal(loopOf(), 2, "2.936: four or more loops use the table");
    assert.equal(loopOf("2.917"), 0, "2.917: more than four loops are not selected");
    assert.equal(loopOf("3.002.149"), 0, "3.002.149: more than four loops need f20");
    assert.equal(loopOf("3.002.149", true), 2, "3.002.149 with f20 set");
  });

  test("restart bypass by f16 is a profile variant", () => {
    // 2.411 always displays the confirmation prompt; other profiles accept
    // restart while f16 is set (spec: action 0x80).
    const SOURCE = `
      if (!isset(f220)) { set(f220); set(f16); assignn(v210, 9); restart.game(); }
      return;
    `;
    const later = boot(SOURCE).engine;
    assert.equal(later.vars[210], 0, "2.936 restarted, clearing the variable");
    const prompt = boot(SOURCE, "2.411").engine;
    assert.equal(prompt.vars[210], 9, "2.411 does not restart without confirmation");
  });
});
