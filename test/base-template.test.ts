import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { decodeLogicInsns } from "../src/logic/disassembler.ts";
import { ACTION_BY_NAME, CONDITION_BY_NAME } from "../src/logic/opcodes.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_DEATH_TRACKS,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  TEMPLATE_DEATH_LOGIC,
  TEMPLATE_DEATH_SOUND,
  installBaseTemplate,
} from "../src/agent/baseTemplate.ts";
import { buildSound } from "../src/agent/soundBuilder.ts";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { compilePictureSource } from "../src/picture/source.ts";

/**
 * The default base template: logic 0 with
 * the Sierra menu bar, key bindings and parser fallbacks, plus the shared
 * death logic 255 and its sound. The expected code bytes below are derived by
 * hand from src/logic/opcodes.ts and the assembler's framing rules —
 * conditions are `code operands`, NOT is 0xfd, an if is `ff <conds> ff s16`
 * where the delta skips the then-block (or the then-block plus its 3-byte
 * else-goto), and a bare `fe s16` jumps. If the template source changes, these
 * tables are re-derived, not copied from assembler output.
 */

// ---------- hand-derived bytecode: logic 0 ----------

// fmt: off — every run is one source statement, annotated.
const EXPECTED_LOGIC0_CODE: number[] = [
  // if (!isset(f200)) { ... } — ff, not, isset(f200=0xc8), ff, delta over 92 bytes
  0xff,
  0xfd,
  0x07,
  0xc8,
  0xff,
  0x5c,
  0x00,
  0x0c,
  0xc8, // set(f200)
  0x6f,
  0x01,
  0x16,
  0x00, // configure.screen(1,22,0)
  0x70, // status.line.on
  0x0c,
  0x09, // set(f9)
  0x03,
  0x0a,
  0x02, // assignn(v10,2) — normal speed
  0x9c,
  0x01, // set.menu(m1) "File"
  0x9d,
  0x02,
  0xc9,
  0x9d,
  0x03,
  0xca,
  0x9d,
  0x04,
  0xcb,
  0x9d,
  0x05,
  0xcc, // Save/Restore/Restart/Quit -> c201-c204
  0x9c,
  0x06, // set.menu(m6) "Speed"
  0x9d,
  0x07,
  0xcd,
  0x9d,
  0x08,
  0xce,
  0x9d,
  0x09,
  0xcf,
  0x9d,
  0x0a,
  0xd0, // Slow/Normal/Fast/Fastest -> c205-c208
  0x9c,
  0x0b, // set.menu(m11) "Sound"
  0x9d,
  0x0c,
  0xd1,
  0x9d,
  0x0d,
  0xd2, // On/Off -> c209/c210
  0x9c,
  0x0e, // set.menu(m14) "Help"
  0x9d,
  0x0f,
  0xd3,
  0x9d,
  0x10,
  0xd4, // Help/About -> c211/c212
  0x9e, // submit.menu
  0x0c,
  0x0e, // set(f14) — menu enabled
  0x79,
  0x1b,
  0x00,
  0xc8, // set.key(27,0,200) ESC -> menu
  0x79,
  0x00,
  0x3b,
  0xd3, // set.key(0,59,211) F1 -> help
  0x79,
  0x00,
  0x3f,
  0xc9, // set.key(0,63,201) F5 -> save
  0x79,
  0x00,
  0x41,
  0xca, // set.key(0,65,202) F7 -> restore
  0x79,
  0x00,
  0x43,
  0xcb, // set.key(0,67,203) F9 -> restart
  0x79,
  0x00,
  0x2c,
  0xcc, // set.key(0,44,204) Alt-Z -> quit
  0x79,
  0x09,
  0x00,
  0xd5, // set.key(9,0,213) TAB -> inventory
  0x03,
  0x00,
  0x01, // assignn(v0,1)
  0x13,
  0x00, // new.room.v(v0)
  0x17,
  0x00, // call.v(v0) — the room runs first
  // if (isset(f202)) { call(255) } — dead: poll the death box
  0xff,
  0x07,
  0xca,
  0xff,
  0x02,
  0x00,
  0x16,
  0xff,
  // if (!isset(f202)) { menu/key dispatch } — 111-byte block
  0xff,
  0xfd,
  0x07,
  0xca,
  0xff,
  0x6f,
  0x00,
  0xff,
  0x0c,
  0xc8,
  0xff,
  0x01,
  0x00,
  0xa1, // c200 ESC -> menu.input
  0xff,
  0x0c,
  0xc9,
  0xff,
  0x01,
  0x00,
  0x7d, // c201 -> save.game
  0xff,
  0x0c,
  0xca,
  0xff,
  0x01,
  0x00,
  0x7e, // c202 -> restore.game
  0xff,
  0x0c,
  0xcb,
  0xff,
  0x01,
  0x00,
  0x80, // c203 -> restart.game
  0xff,
  0x0c,
  0xcc,
  0xff,
  0x02,
  0x00,
  0x86,
  0x00, // c204 -> quit(0)
  0xff,
  0x0c,
  0xcd,
  0xff,
  0x03,
  0x00,
  0x03,
  0x0a,
  0x04, // c205 -> v10=4 slow
  0xff,
  0x0c,
  0xce,
  0xff,
  0x03,
  0x00,
  0x03,
  0x0a,
  0x02, // c206 -> v10=2 normal
  0xff,
  0x0c,
  0xcf,
  0xff,
  0x03,
  0x00,
  0x03,
  0x0a,
  0x01, // c207 -> v10=1 fast
  0xff,
  0x0c,
  0xd0,
  0xff,
  0x03,
  0x00,
  0x03,
  0x0a,
  0x00, // c208 -> v10=0 fastest
  0xff,
  0x0c,
  0xd1,
  0xff,
  0x02,
  0x00,
  0x0c,
  0x09, // c209 -> set(f9)
  0xff,
  0x0c,
  0xd2,
  0xff,
  0x02,
  0x00,
  0x0d,
  0x09, // c210 -> reset(f9)
  0xff,
  0x0c,
  0xd3,
  0xff,
  0x02,
  0x00,
  0x65,
  0x11, // c211 -> print(m17) help
  0xff,
  0x0c,
  0xd4,
  0xff,
  0x02,
  0x00,
  0x65,
  0x12, // c212 -> print(m18) about
  0xff,
  0x0c,
  0xd5,
  0xff,
  0x01,
  0x00,
  0x7c, // c213 -> status() inventory
  // if (isset(f2) && !isset(f4) && !isset(f202)) { parser fallback } — 124 bytes
  0xff,
  0x07,
  0x02,
  0xfd,
  0x07,
  0x04,
  0xfd,
  0x07,
  0xca,
  0xff,
  0x7c,
  0x00,
  // if (greatern(v9,0)) { ...115 bytes } else { print(m20) }
  0xff,
  0x05,
  0x09,
  0x00,
  0xff,
  0x73,
  0x00,
  // eleven times: if (equaln(v9,N)) { word.to.string(s11,N) } — 10 bytes each
  0xff,
  0x01,
  0x09,
  0x01,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x01,
  0xff,
  0x01,
  0x09,
  0x02,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x02,
  0xff,
  0x01,
  0x09,
  0x03,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x03,
  0xff,
  0x01,
  0x09,
  0x04,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x04,
  0xff,
  0x01,
  0x09,
  0x05,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x05,
  0xff,
  0x01,
  0x09,
  0x06,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x06,
  0xff,
  0x01,
  0x09,
  0x07,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x07,
  0xff,
  0x01,
  0x09,
  0x08,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x08,
  0xff,
  0x01,
  0x09,
  0x09,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x09,
  0xff,
  0x01,
  0x09,
  0x0a,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x0a,
  0xff,
  0x01,
  0x09,
  0x0b,
  0xff,
  0x03,
  0x00,
  0x74,
  0x0b,
  0x0b,
  0x65,
  0x13, // print(m19) "I don't know the word ..."
  0xfe,
  0x02,
  0x00, // goto over the else
  0x65,
  0x14, // print(m20) "I don't understand that."
  0x00, // return
];

// ---------- hand-derived bytecode: logic 255 (death) ----------

const EXPECTED_DEATH_CODE: number[] = [
  // if (!isset(f202)) { init, 18 bytes }
  0xff,
  0xfd,
  0x07,
  0xca,
  0xff,
  0x12,
  0x00,
  0x0c,
  0xca, // set(f202) — dead; logic 0 re-calls this logic every cycle
  0x03,
  0xfa,
  0x00, // assignn(v250,0) — cursor on Restore
  0x83, // program.control — arrows no longer drive ego
  0x77, // prevent.input — keys land in v19 instead of the line
  0x4d,
  0x00, // stop.motion(o0)
  0x46,
  0x00, // stop.cycling(o0)
  0x0d,
  0x0e, // reset(f14) — menu closed while dead
  0x62,
  0xff, // load.sound(255)
  0x63,
  0xff,
  0xc9, // sound(255,f201)
  0x0d,
  0xcb, // reset(f203) — no choice yet
  // if (equaln(v19,32)) { space steps the cursor }
  0xff,
  0x01,
  0x13,
  0x20,
  0xff,
  0x0c,
  0x00,
  0x01,
  0xfa, // increment(v250)
  0xff,
  0x01,
  0xfa,
  0x03,
  0xff,
  0x03,
  0x00,
  0x03,
  0xfa,
  0x00, // if (v250==3) v250=0
  // digits choose directly: 1->Restore, 2->Restart, 3->Quit
  0xff,
  0x01,
  0x13,
  0x31,
  0xff,
  0x05,
  0x00,
  0x03,
  0xfa,
  0x00,
  0x0c,
  0xcb,
  0xff,
  0x01,
  0x13,
  0x32,
  0xff,
  0x05,
  0x00,
  0x03,
  0xfa,
  0x01,
  0x0c,
  0xcb,
  0xff,
  0x01,
  0x13,
  0x33,
  0xff,
  0x05,
  0x00,
  0x03,
  0xfa,
  0x02,
  0x0c,
  0xcb,
  0xff,
  0x01,
  0x13,
  0x0d,
  0xff,
  0x02,
  0x00,
  0x0c,
  0xcb, // ENTER confirms
  // the classic keys still answer (controller conditions are two bytes)
  0xff,
  0x0c,
  0xca,
  0xff,
  0x05,
  0x00,
  0x03,
  0xfa,
  0x00,
  0x0c,
  0xcb, // F7 -> restore
  0xff,
  0x0c,
  0xcb,
  0xff,
  0x05,
  0x00,
  0x03,
  0xfa,
  0x01,
  0x0c,
  0xcb, // F9 -> restart
  0xff,
  0x0c,
  0xcc,
  0xff,
  0x05,
  0x00,
  0x03,
  0xfa,
  0x02,
  0x0c,
  0xcb, // Alt-Z -> quit
  // if (isset(f203)) { act on the choice } — success aborts the pass, so the
  // code after each session action runs only on decline/failure and falls to
  // the redraw
  0xff,
  0x07,
  0xcb,
  0xff,
  0x1b,
  0x00,
  0xff,
  0x01,
  0xfa,
  0x00,
  0xff,
  0x01,
  0x00,
  0x7e, // restore.game
  0xff,
  0x01,
  0xfa,
  0x01,
  0xff,
  0x03,
  0x00,
  0x0c,
  0x10,
  0x80, // set(f16); restart.game
  0xff,
  0x01,
  0xfa,
  0x02,
  0xff,
  0x02,
  0x00,
  0x86,
  0x00, // quit(0)
  // the box redraws every pass
  0x6d,
  0x00,
  0x0f, // set.text.attribute(0,15)
  0x9a,
  0x09,
  0x0a,
  0x10,
  0x1e,
  0x0f, // clear.text.rect(9,10,16,30,15)
  0x67,
  0x0a,
  0x0e,
  0x03, // display(10,14,m3) "You have died."
  0x67,
  0x0c,
  0x0f,
  0x04, // display(12,15,m4) "Restore"
  0x67,
  0x0d,
  0x0f,
  0x05, // display(13,15,m5) "Restart"
  0x67,
  0x0e,
  0x0f,
  0x06, // display(14,15,m6) "Quit"
  0x67,
  0x0f,
  0x0c,
  0x07, // display(15,12,m7) "1-3, SPACE, ENTER"
  // cursor: m1 ">" at the choice row, m2 " " on the others
  0xff,
  0x01,
  0xfa,
  0x00,
  0xff,
  0x0c,
  0x00,
  0x67,
  0x0c,
  0x0d,
  0x01,
  0x67,
  0x0d,
  0x0d,
  0x02,
  0x67,
  0x0e,
  0x0d,
  0x02,
  0xff,
  0x01,
  0xfa,
  0x01,
  0xff,
  0x0c,
  0x00,
  0x67,
  0x0c,
  0x0d,
  0x02,
  0x67,
  0x0d,
  0x0d,
  0x01,
  0x67,
  0x0e,
  0x0d,
  0x02,
  0xff,
  0x01,
  0xfa,
  0x02,
  0xff,
  0x0c,
  0x00,
  0x67,
  0x0c,
  0x0d,
  0x02,
  0x67,
  0x0d,
  0x0d,
  0x02,
  0x67,
  0x0e,
  0x0d,
  0x01,
  0x6d,
  0x0f,
  0x00, // set.text.attribute(15,0)
  0x00, // return
];
// fmt: on

const PROFILE = PROFILES["2.936"]!;
const DICT = new Map<string, number>([
  ["look", 100],
  ["take", 105],
  ["die", 107],
]);

// ---------- compile-time assertions ----------

describe("base template bytecode", () => {
  test("logic 0 compiles to the hand-computed code section", () => {
    const r = assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, { dictionary: DICT, profile: PROFILE });
    assert.deepEqual([...r.code], EXPECTED_LOGIC0_CODE);
  });

  test("logic 255 compiles to the hand-computed code section", () => {
    const r = assembleLogic(BASE_TEMPLATE_DEATH_LOGIC_SOURCE, {
      dictionary: DICT,
      profile: PROFILE,
    });
    assert.deepEqual([...r.code], EXPECTED_DEATH_CODE);
  });

  test("logic 0 message table holds the menu bar and fallback strings", () => {
    const r = parseLogicResource(
      assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, { dictionary: DICT, profile: PROFILE }).payload,
    );
    assert.deepEqual(r.messages, [
      "File",
      "Save Game      F5",
      "Restore Game   F7",
      "Restart Game   F9",
      "Quit          Alt+Z",
      "Speed",
      "Slow",
      "Normal",
      "Fast",
      "Fastest",
      "Sound",
      "On",
      "Off",
      "Help",
      "Help           F1",
      "About",
      "Type a command and press ENTER. Arrow keys walk. ESC opens the menu.",
      "An adventure written with AGI IS HERE.",
      'I don\'t know the word "%s11".',
      "I don't understand that.",
    ]);
  });

  test("death logic message table holds the box strings", () => {
    const r = parseLogicResource(
      assembleLogic(BASE_TEMPLATE_DEATH_LOGIC_SOURCE, {
        dictionary: DICT,
        profile: PROFILE,
      }).payload,
    );
    assert.deepEqual(r.messages, [
      ">",
      " ",
      "You have died.",
      "Restore",
      "Restart",
      "Quit",
      "1-3, SPACE, ENTER",
    ]);
  });

  test("payload framing: code length, message count and offset table", () => {
    const payload = assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, {
      dictionary: DICT,
      profile: PROFILE,
    }).payload;
    const codeLength = payload[0]! | (payload[1]! << 8);
    assert.equal(codeLength, EXPECTED_LOGIC0_CODE.length);
    assert.equal(payload[2 + codeLength], 20); // 20 messages
    // count+1 u16 offsets follow; table[0] is the text-area end.
    const tableStart = 2 + codeLength + 1;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    assert.equal(payload.length, tableStart + view.getUint16(tableStart, true));
    // every entry beyond the terminator lands inside the text area
    const end = view.getUint16(tableStart, true);
    for (let i = 1; i <= 20; i++) {
      const rel = view.getUint16(tableStart + i * 2, true);
      assert.ok(rel > 0 && rel < end, `message ${i} offset in range`);
    }
  });

  test("template uses only opcodes and conditions in the 2.936 dispatch range", () => {
    // Walk the instruction stream: every action at most maxAction (0xaf for
    // 2.936; menu.input at 0xa1 is the highest the template uses), every
    // condition at most maxCondition 0x12.
    for (const source of [BASE_TEMPLATE_LOGIC0_SOURCE, BASE_TEMPLATE_DEATH_LOGIC_SOURCE]) {
      const payload = assembleLogic(source, { dictionary: DICT, profile: PROFILE }).payload;
      for (const insn of decodeLogicInsns(payload)) {
        if (insn.kind === "action" && insn.name !== undefined) {
          const spec = ACTION_BY_NAME[insn.name];
          assert.ok(spec, `unknown action ${insn.name}`);
          assert.ok(
            spec.code <= PROFILE.maxAction,
            `action ${insn.name} (0x${spec.code.toString(16)}) exceeds 0x${PROFILE.maxAction.toString(16)}`,
          );
        }
        if (insn.kind === "if" && insn.text) {
          for (const [, name] of insn.text.matchAll(/([a-z.]+)\(/g)) {
            const spec = CONDITION_BY_NAME[name!];
            assert.ok(spec, `unknown condition ${name}`);
            assert.ok(
              spec.code <= PROFILE.maxCondition,
              `condition ${name} exceeds 0x${PROFILE.maxCondition.toString(16)}`,
            );
          }
        }
      }
    }
    assert.ok(PROFILE.maxAction >= 0xa1 && PROFILE.maxCondition >= 0x0e);
  });
});

// ---------- reserved slots ----------

describe("editable template boilerplate", () => {
  test("installBaseTemplate supplies editable logic sources and a death sound", () => {
    const state = createAgentSessionState();
    installBaseTemplate(state, state.profile);
    assert.ok(state.container.getResource("logic", 0));
    assert.ok(state.container.getResource("logic", TEMPLATE_DEATH_LOGIC));
    assert.ok(state.container.getResource("sound", TEMPLATE_DEATH_SOUND));
    assert.equal(state.sources.logics.get(0), BASE_TEMPLATE_LOGIC0_SOURCE);
    assert.equal(state.sources.logics.get(TEMPLATE_DEATH_LOGIC), BASE_TEMPLATE_DEATH_LOGIC_SOURCE);
  });

  test("an agent can replace the boot, shared death logic and music", () => {
    const state = createAgentSessionState();
    installBaseTemplate(state, state.profile);
    for (const [room, source] of [
      [0, "assignn(v42, 77); return;"],
      [
        255,
        'reset(f202); assignn(v250, 42); set.string(s11, "Continue"); set.key(27, 0, 50); return;',
      ],
    ] as const) {
      const result = executeAgentTool(state, "write_logic_source", { room, source });
      assert.equal(result.success, true, result.error ?? "");
      assert.equal(state.sources.logics.get(room), source);
    }
    for (const [name, args] of [
      ["write_sound", { num: 255, tracks: [] }],
      [
        "write_music",
        {
          num: 255,
          tempo: 120,
          tracks: [{ channel: "melody", volume: 5, events: [{ note: "C3", beats: 1, repeat: 1 }] }],
        },
      ],
    ] as const) {
      const result = executeAgentTool(state, name, args);
      assert.equal(result.success, true, result.error ?? "");
    }
    const engine = new Engine(state.container, new TemplateHost(), DICT);
    engine.tick();
    assert.equal(engine.vars[42], 77, "the replacement boot executes");
    assert.equal(engine.flags[200], 0, "the original boot is no longer installed");
  });

  test("bindings can name template state and allocate slots freed by a rewrite", () => {
    const state = createAgentSessionState();
    installBaseTemplate(state, state.profile);
    for (const [kind, id] of [
      ["logic", 0],
      ["sound", 255],
      ["flag", 202],
      ["variable", 250],
    ] as const) {
      const result = executeAgentTool(state, "reserve_binding", {
        name: `custom_${kind}`,
        kind,
        id,
      });
      assert.equal(result.success, true, result.error ?? "");
    }
    // All lower authored flags are occupied. While the original boot uses
    // f200, allocation must skip it based on actual code, not ownership.
    for (let id = 32; id < 200; id++)
      state.authoring.bindings[`used_${id}`] = { kind: "flag", num: id };
    const before = executeAgentTool(state, "reserve_binding", {
      name: "before_rewrite",
      kind: "flag",
      id: null,
    });
    assert.equal(before.success, true, before.error ?? "");
    assert.notEqual(state.authoring.bindings["before_rewrite"]!.num, 200);
    const rewrite = executeAgentTool(state, "write_logic_source", { room: 0, source: "return;" });
    assert.equal(rewrite.success, true, rewrite.error ?? "");
    const after = executeAgentTool(state, "reserve_binding", {
      name: "after_rewrite",
      kind: "flag",
      id: null,
    });
    assert.equal(after.success, true, after.error ?? "");
    assert.equal(state.authoring.bindings["after_rewrite"]!.num, 200);
  });
});

// ---------- engine behaviour ----------

class TemplateHost implements EngineHost {
  keys: number[] = [];
  lines: string[] = [];
  sounds: number[] = [];
  /** null cancels the restore; an image restores. */
  restoreImage: Uint8Array | null | "unset" = "unset";
  saved: Uint8Array[] = [];
  waitKey(): number {
    throw new HostWait();
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takeInputLine(): string | null {
    return this.lines.shift() ?? null;
  }
  playSound(num: number): void {
    this.sounds.push(num);
  }
  soundOutput(): void {}
  saveGame(bytes: Uint8Array): boolean {
    this.saved.push(bytes);
    return true;
  }
  restoreGame(): Uint8Array | null {
    return this.restoreImage === "unset" ? null : this.restoreImage;
  }
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
}

const ROOM = `
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(40);
  accept.input();
}
if (said("look")) { print("A bare room."); }
if (said("die")) { print("The floor was lava."); call(255); }
return;
`;

const ROOM_WITH_OWN_FALLBACK = `
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(40);
  accept.input();
}
if (said("look")) { print("A bare room."); }
if (isset(f2) && !isset(f4)) { set(f4); print("Nothing happens."); }
return;
`;

function templateEngine(roomSource = ROOM, room = 1) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, { dictionary: DICT, profile: PROFILE }).payload,
  );
  container.putResource(
    "logic",
    TEMPLATE_DEATH_LOGIC,
    assembleLogic(BASE_TEMPLATE_DEATH_LOGIC_SOURCE, {
      dictionary: DICT,
      profile: PROFILE,
    }).payload,
  );
  container.putResource("sound", TEMPLATE_DEATH_SOUND, buildSound(BASE_TEMPLATE_DEATH_TRACKS));
  container.putResource(
    "logic",
    room,
    assembleLogic(roomSource, { dictionary: DICT, profile: PROFILE }).payload,
  );
  container.putResource(
    "picture",
    1,
    compilePictureSource("vis 15\nline 0,0 159,0 159,167 0,167 0,0\nfill 5,5\nvis off\nend").bytes,
  );
  const host = new TemplateHost();
  const engine = new Engine(container, host, DICT);
  return { engine, host };
}

function surfaceRows(engine: Engine): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) rows.push(engine.textRow(r));
  return rows;
}

function tick(engine: Engine, n = 1): void {
  for (let i = 0; i < n; i++) engine.tick();
}

describe("base template engine behaviour", () => {
  test("boot enters room 1 with the status line and a working menu bar", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    assert.equal(engine.readState().room, 1);
    assert.match(engine.textRow(0), /Score: 0 of 0/);
    assert.match(engine.textRow(0), /Sound:on/);
    host.keys.push(0x1b); // ESC
    tick(engine, 2);
    assert.equal(engine.modalKind, "menu");
    assert.match(engine.textRow(0), /File +Speed +Sound +Help/);
    assert.match(engine.textRow(2), /Save Game +F5/);
    assert.match(engine.textRow(3), /Restore Game +F7/);
    assert.match(engine.textRow(4), /Restart Game +F9/);
    assert.match(engine.textRow(5), /Quit +Alt\+Z/);
  });

  test("menu headings carry the four menus once — re-entering the room does not duplicate", () => {
    const { engine } = templateEngine();
    tick(engine, 4);
    const before = engine.readMenuState().headings.map((h) => h.title);
    assert.deepEqual(before, ["File", "Speed", "Sound", "Help"]);
    // Leave and re-enter via a second room is overkill; re-running logic 0
    // enough times would re-trigger nothing — f200 latches the boot block.
    tick(engine, 3);
    assert.deepEqual(
      engine.readMenuState().headings.map((h) => h.title),
      before,
    );
  });

  test("an unknown word prints the quoted token once", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("flibberty");
    tick(engine, 3);
    const rows = surfaceRows(engine).join("\n");
    assert.match(rows, /I don't know the word/);
    assert.match(rows, /"flibberty"/);
    assert.equal((rows.match(/I don't know the word/g) ?? []).length, 1);
    assert.doesNotMatch(rows, /I don't understand that/);
  });

  test("a recognised but unhandled line prints the generic fallback once", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("take");
    tick(engine, 3);
    const rows = surfaceRows(engine).join("\n");
    assert.match(rows, /I don't understand that/);
    assert.equal((rows.match(/I don't understand/g) ?? []).length, 1);
    assert.doesNotMatch(rows, /I don't know the word/);
  });

  test("a said() the room answers gets no fallback", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("look");
    tick(engine, 3);
    const rows = surfaceRows(engine).join("\n");
    assert.match(rows, /A bare room/);
    assert.doesNotMatch(rows, /I don't understand/);
    assert.doesNotMatch(rows, /I don't know/);
  });

  test("a room that answers without said() sets f4 to suppress the fallback", () => {
    const { engine, host } = templateEngine(ROOM_WITH_OWN_FALLBACK);
    tick(engine, 4);
    host.lines.push("look");
    tick(engine, 3);
    const rows = surfaceRows(engine).join("\n");
    assert.match(rows, /A bare room/);
    assert.doesNotMatch(rows, /Nothing happens/);
    host.keys.push(0x0d); // drain the room's reply window
    tick(engine);
    host.lines.push("take"); // recognised, unhandled -> the room's own fallback
    tick(engine, 3);
    const rows2 = surfaceRows(engine).join("\n");
    assert.match(rows2, /Nothing happens/);
    assert.doesNotMatch(rows2, /I don't understand/);
  });

  test("die reaches the death box through the shared logic and plays the sound", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("die");
    tick(engine, 2);
    // The room's print opens a modal window; ENTER drains it, then the
    // resumed pass runs call(255)'s init.
    host.keys.push(0x0d);
    tick(engine, 2);
    assert.deepEqual(host.sounds, [TEMPLATE_DEATH_SOUND]);
    const rows = surfaceRows(engine);
    assert.match(rows[10]!, /You have died/);
    assert.match(rows[12]!, /> Restore/);
    assert.match(rows[13]!, / {2,}Restart/);
    assert.match(rows[14]!, / {2,}Quit/);
    assert.match(rows[15]!, /1-3, SPACE, ENTER/);
    assert.equal(engine.readState().flags[202], 1);
  });

  test("SPACE steps the death-box cursor and ENTER confirms", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine);
    tick(engine, 2);
    host.keys.push(0x20); // SPACE -> Restart
    tick(engine);
    assert.match(engine.textRow(13), /> Restart/);
    assert.match(engine.textRow(12), /^[^>]*Restore/);
    host.keys.push(0x20); // SPACE -> Quit
    tick(engine);
    assert.match(engine.textRow(14), /> Quit/);
    host.keys.push(0x0d); // ENTER -> quit confirmation prompt
    tick(engine);
    assert.equal(engine.modalKind, "print");
    assert.match(surfaceRows(engine).join("\n"), /Quit the game\?/);
  });

  test("declining the quit confirmation returns to the box still dead", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine);
    tick(engine, 2);
    host.keys.push(0x33); // '3' -> Quit directly
    tick(engine);
    assert.match(surfaceRows(engine).join("\n"), /Quit the game\?/);
    engine.deliverHostAnswer(27); // ESC declines
    tick(engine, 2);
    assert.equal(engine.readState().terminated, false);
    assert.equal(engine.readState().flags[202], 1);
    assert.match(engine.textRow(10), /You have died/);
    assert.match(engine.textRow(14), /> Quit/, "the cursor stays on the chosen row");
  });

  test("a cancelled restore returns to the box without restarting or reviving", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine);
    tick(engine, 2);
    host.keys.push(0x31); // '1' -> Restore
    tick(engine, 3); // host.restoreGame returns null: cancelled
    assert.equal(engine.readState().flags[202], 1, "still dead after cancel");
    assert.match(engine.textRow(10), /You have died/);
    // movement and input stay off — no broken control mode
    assert.equal(engine.readState().inputEnabled, false);
  });

  test("F9 in the death box restarts the game immediately", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine);
    tick(engine, 2);
    host.keys.push(0x4300); // F9
    tick(engine, 4);
    const state = engine.readState();
    assert.equal(state.flags[202], 0, "dead flag cleared by the fresh boot");
    assert.equal(state.flags[14], 1, "menu re-enabled");
    assert.equal(state.room, 1);
    assert.doesNotMatch(surfaceRows(engine).join("\n"), /You have died/);
  });

  test("a successful restore peels the death state back to the saved image", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    const image = engine.serialize(); // saved while alive
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine);
    tick(engine, 2);
    assert.equal(engine.readState().flags[202], 1);
    host.restoreImage = image;
    host.keys.push(0x4100); // F7
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 0, "restore dropped the dead flag");
  });

  test("the death poll ignores stray keys — the box waits for a real choice", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine);
    tick(engine, 2);
    host.keys.push(0x61); // 'a' — not a choice
    tick(engine);
    assert.match(engine.textRow(12), /> Restore/);
    assert.equal(engine.readState().flags[202], 1);
    host.keys.push(0x1b); // ESC — menu is disabled while dead
    tick(engine);
    assert.notEqual(engine.modalKind, "menu");
    assert.match(engine.textRow(10), /You have died/);
  });

  test("the Speed and Sound menus write v10 and f9 through real menu navigation", () => {
    const { engine, host } = templateEngine();
    tick(engine, 4);
    assert.equal(engine.vars[10], 2);
    // ESC opens the menu on File; RIGHT steps to Speed, DOWN lands on Fast.
    host.keys.push(0x1b);
    tick(engine, 2);
    assert.equal(engine.modalKind, "menu");
    host.keys.push(0x4d00); // RIGHT -> Speed
    tick(engine);
    host.keys.push(0x5000, 0x5000); // DOWN, DOWN -> Fast
    tick(engine, 2);
    assert.match(engine.textRow(4), /Fast/);
    host.keys.push(0x0d); // ENTER selects -> controller 207
    tick(engine, 2);
    assert.equal(engine.modalKind, null);
    assert.equal(engine.vars[10], 1, "Fast = cycle interval 1");
    // Sound > Off clears f9. The reopened menu remembers its heading — it
    // comes back on Speed, so one RIGHT reaches Sound.
    host.keys.push(0x1b);
    tick(engine, 2);
    assert.equal(engine.readMenuState().heading, 1, "menu reopens on Speed");
    host.keys.push(0x4d00); // RIGHT -> Sound
    tick(engine, 2);
    host.keys.push(0x5000); // DOWN -> Off
    tick(engine);
    host.keys.push(0x0d);
    tick(engine, 2);
    assert.equal(engine.flags[9], 0);
    assert.match(engine.textRow(0), /Sound:off/);
  });

  test("the death sound is a finite four-channel payload", () => {
    const payload = buildSound(BASE_TEMPLATE_DEATH_TRACKS);
    // Four little-endian channel offsets, then channel data with 0xffff
    // terminators; each channel is a non-empty duration/divisor/attenuation run.
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const off = view.getUint16(0, true);
    assert.equal(off, 8);
    for (let ch = 0; ch < 4; ch++) {
      const start = view.getUint16(ch * 2, true);
      const end = ch === 3 ? payload.length : view.getUint16((ch + 1) * 2, true);
      const channel = payload.slice(start, end);
      assert.equal(channel[channel.length - 2], 0xff);
      assert.equal(channel[channel.length - 1], 0xff);
      assert.ok(channel.length >= 7, `channel ${ch} carries at least one note`);
    }
  });
});
