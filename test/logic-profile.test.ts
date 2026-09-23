import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleLogic } from "../src/logic/assembler.ts";
import { disassembleLogic, disassembleLogicWarnings } from "../src/logic/disassembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const dictionary = new Map<string, number>();

describe("profile-selected logic bytecode", () => {
  for (const id of ["2.089", "2.230"] as const) {
    it(`${id} consumes no operand for quit and preserves the following action`, () => {
      const opts = { dictionary, profile: PROFILES[id] };
      const code = new Uint8Array([0x86, 3, 200, 42, 0]);
      assert.deepEqual(assembleLogic("quit(); assignn(v200, 42); return;", opts).code, code);
      const payload = buildLogicResource(code, []);
      assert.deepEqual(disassembleLogicWarnings(payload, opts), []);
      assert.deepEqual(assembleLogic(disassembleLogic(payload, opts), opts).code, code);
      assert.throws(() => assembleLogic("quit(1); return;", opts), /takes 0 operand/);
    });
  }

  it("accepts the 3.002.086 ignored byte without consuming the next instruction", () => {
    const opts = { dictionary, profile: PROFILES["3.002.086"] };
    const code = new Uint8Array([0xb0, 7, 0xb1, 1, 3, 200, 42, 0]);
    const source = "hide.mouse(7); allow.menu(1); assignn(v200, 42); return;";
    assert.deepEqual(assembleLogic(source, opts).code, code);
    const payload = buildLogicResource(code, []);
    assert.deepEqual(disassembleLogicWarnings(payload, opts), []);
    assert.deepEqual(assembleLogic(disassembleLogic(payload, opts), opts).code, code);
  });

  for (const id of ["3.002.102", "3.002.149"] as const) {
    it(`${id} round-trips every v3 extension width`, () => {
      const opts = { dictionary, profile: PROFILES[id] };
      const code = new Uint8Array([0xb0, 0xb1, 1, 0xb2, 0xb3, 1, 2, 3, 4, 0xb4, 200, 201, 0xb5, 0]);
      const source =
        "hide.mouse(); allow.menu(1); show.mouse(); fence.mouse(1,2,3,4); mouse.posn(v200,v201); release.key(); return;";
      assert.deepEqual(assembleLogic(source, opts).code, code);
      const payload = buildLogicResource(code, []);
      assert.deepEqual(disassembleLogicWarnings(payload, opts), []);
      assert.deepEqual(assembleLogic(disassembleLogic(payload, opts), opts).code, code);
    });
  }

  it("rejects actions beyond an early profile's range", () => {
    assert.throws(
      () => assembleLogic("set.menu(1);", { dictionary, profile: PROFILES["2.230"] }),
      /not available.*2\.230/,
    );
    assert.throws(
      () => assembleLogic("hold.key();", { dictionary, profile: PROFILES["2.411"] }),
      /not available.*2\.411/,
    );
    assert.throws(
      () => assembleLogic("set.pri.base(40);", { dictionary, profile: PROFILES["2.917"] }),
      /not available.*2\.917/,
    );
  });

  it("marks opcodes unavailable in a selected profile instead of interpreting them as newer actions", () => {
    const opts = { dictionary, profile: PROFILES["2.230"] };
    assert.notDeepEqual(
      disassembleLogicWarnings(buildLogicResource(new Uint8Array([0xa1, 0]), []), opts),
      [],
    );
  });

  it("applies the selected condition bound in both directions", () => {
    const opts = { dictionary, profile: { ...PROFILES["2.936"], maxCondition: 0x11 } };
    assert.throws(
      () => assembleLogic("if (right.posn(o0, 0, 0, 1, 1)) { return; }", opts),
      /not available/,
    );
    const payload = buildLogicResource(
      new Uint8Array([0xff, 0x12, 0, 0, 0, 1, 1, 0xff, 1, 0, 0]),
      [],
    );
    assert.notDeepEqual(disassembleLogicWarnings(payload, opts), []);
  });

  it("iigs-1.014 reads the sound-fade pair and a zero-operand terminate slot", () => {
    const opts = { dictionary, profile: PROFILES["iigs-1.014"] };
    const code = new Uint8Array([0xaf, 40, 0xb0, 53, 0xb1, 0]);
    const source = "fade.sound(40); fade.sound.v(v53); terminate(); return;";
    assert.deepEqual(assembleLogic(source, opts).code, code);
    const payload = buildLogicResource(code, []);
    assert.deepEqual(disassembleLogicWarnings(payload, opts), []);
    assert.deepEqual(assembleLogic(disassembleLogic(payload, opts), opts).code, code);
  });

  for (const id of ["amiga-2.310", "amiga-2.316", "amiga-2.333"] as const) {
    it(`${id} round-trips the 0xad..0xb6 tail at the dispatch table's widths`, () => {
      // Operand counts from the six-byte records of the PQ/GR/MH2 action
      // tables (data hunk 5, record n at n * 6, count byte at +4): 0xad 0,
      // 0xae 1, 0xaf 1 (h5+0x41e), 0xb0 0, 0xb1 1, 0xb2 0, 0xb3 4, 0xb4 2,
      // 0xb5 0, 0xb6 2 (docs/fidelity.md "Amiga interpreter profiles").
      const opts = { dictionary, profile: PROFILES[id] };
      const code = new Uint8Array([
        0xad, 0xae, 40, 0xaf, 5, 0xb0, 0xb1, 1, 0xb2, 0xb3, 1, 2, 3, 4, 0xb4, 200, 201, 0xb5, 0xb6,
        2, 0xfe, 0,
      ]);
      const source =
        "hold.key(); set.pri.base(40); discard.sound(5); hide.mouse(); allow.menu(1); show.mouse(); " +
        "fence.mouse(1,2,3,4); mouse.posn(v200,v201); release.key(); adj.ego.move.to.x.y(2, 254); return;";
      assert.deepEqual(assembleLogic(source, opts).code, code);
      const payload = buildLogicResource(code, []);
      assert.deepEqual(disassembleLogicWarnings(payload, opts), []);
      assert.deepEqual(assembleLogic(disassembleLogic(payload, opts), opts).code, code);
    });
  }

  it("iigs-1.014 and amiga-2.082 reject condition 0x13, whose slot overruns the handler table", () => {
    for (const id of ["iigs-1.014", "amiga-2.082"] as const) {
      const opts = { dictionary, profile: PROFILES[id] };
      assert.throws(
        () => assembleLogic("if (click.move.pending()) { return; } return;", opts),
        new RegExp(`not available.*${id.replace(".", "\\.")}`),
      );
    }
    // The Amiga 2.31x handler is real, so the name assembles there.
    const amiga = { dictionary, profile: PROFILES["amiga-2.316"] };
    assert.deepEqual(
      Array.from(assembleLogic("if (click.move.pending()) { return; } return;", amiga).code),
      [0xff, 0x13, 0xff, 0x01, 0x00, 0x00, 0x00],
    );
  });

  it("iigs-1.014 does not resolve the PC v3 tail names", () => {
    const opts = { dictionary, profile: PROFILES["iigs-1.014"] };
    // Slots 0xad/0xae stay shared — they are inside the IIgs table's
    // 0x00..0xb0 range. The 0xaf..0xb6 tail is IIgs-specific: none of the PC
    // v3 or Amiga names at those slots are this interpreter's vocabulary.
    for (const source of [
      "slow.mouse();",
      "hide.mouse(3);",
      "allow.menu(1);",
      "mouse.posn(v1, v2);",
      "discard.sound();",
      "adj.ego.move.to.x.y(1, 2);",
    ])
      assert.throws(() => assembleLogic(source, opts), /not available.*iigs-1\.014/, source);
    assert.notDeepEqual(
      disassembleLogicWarnings(buildLogicResource(new Uint8Array([0xb4, 0]), []), opts),
      [],
    );
  });
});
