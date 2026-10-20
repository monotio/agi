import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type AgiProfile } from "../src/runtime/profile.ts";
import {
  buildView,
  encodeViewBlocks,
  parseView,
  selectViewCel,
  type BuildLoopInput,
} from "../src/view/view.ts";
import { buildViewFromSheet } from "../src/view/sheet.ts";
import { buildViewDocument, openViewDocument } from "../src/view/viewDocument.ts";
import { applyViewEdit } from "../src/studio/view/viewOperations.ts";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import { executeAgentTool } from "../src/agent/tools.ts";

const cel = { width: 3, height: 1, transparentColor: 0, pixels: [1, 2, 0] };
const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function engineFor(
  payload: Uint8Array,
  profile: AgiProfile,
  selection: string,
  preview = false,
): Engine {
  const container = createContainer();
  container.putResource("view", 1, payload);
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) {
      set(f200); load.view(1); animate.obj(o0); set.view(o0, 1);
      fix.loop(o0); stop.cycling(o0); position(o0, 20, 80);
      ${selection} draw(o0); ${preview ? "show.obj(1);" : ""}
    }
    return;
  `,
      { dictionary: new Map(), profile },
    ).payload,
  );
  const engine = new Engine(container, host, new Map(), { profile });
  engine.tick();
  return engine;
}

for (const id of ["2.001", "2.411", "2.936", "2.230"] as const) {
  const profile = PROFILES[id];
  if (id !== "2.230")
    test(`${id}: shared actor and show.obj each keep their native blit orientation across frames`, () => {
      // A native pair: 2.001 ignores the mirror bit; later nonpacked
      // builds orient each blit (F-VIEWS-01).
      const payload = buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] }, PROFILES["2.936"]);
      const engine = engineFor(payload, profile, "set.loop(o0, 1);", true);
      for (let frame = 0; frame < 4; frame++) {
        engine.setEditLine(String(frame));
        const image = engine.getFrame().visual;
        const actor: number[] = id === "2.001" ? [1, 2, 15] : [15, 2, 1];
        assert.deepEqual([...image.slice(80 * 160 + 20, 80 * 160 + 23)], actor);
        assert.deepEqual([...image.slice(167 * 160 + 78, 167 * 160 + 81)], [1, 2, 15]);
      }
    });

  const limit = profile.packedViewLoopHeader ? 3 : profile.celMirrorLoopMask;
  for (const [source, alias] of [
    [Math.max(0, limit - 1), limit],
    [limit, limit + 1],
    [limit + 1, limit + 2],
  ] as const) {
    if (source === alias) continue;
    test(`${id}: authored mirror ${source} -> ${alias} plays stable art and survives Studio reopen and native export`, () => {
      const loops: BuildLoopInput[] = Array.from({ length: alias + 1 }, () => ({ cels: [cel] }));
      loops[alias] = { mirrorLoop: source };
      const payload = buildView({ loops }, profile);
      const view = parseView(payload, profile);
      for (let repeat = 0; repeat < 3; repeat++) {
        assert.deepEqual([...selectViewCel(view, source, 0)!.pixels], [1, 2, 0]);
        assert.deepEqual([...selectViewCel(view, alias, 0)!.pixels], [0, 2, 1]);
        assert.deepEqual([...selectViewCel(view, alias, 0)!.pixels], [0, 2, 1]);
      }
      const document = openViewDocument(payload, profile);
      assert.deepEqual([...document.loops[alias]!.cels[0]!.pixels], [0, 2, 1]);
      assert.deepEqual(buildViewDocument(document, profile), payload);
      const container = createContainer();
      container.putResource("view", 1, buildViewDocument(document, profile));
      const imported = openContainer(container.files, { profile }).getResource("view", 1)!;
      const reopened = openViewDocument(imported, profile);
      assert.deepEqual([...reopened.loops[source]!.cels[0]!.pixels], [1, 2, 0]);
      assert.deepEqual([...reopened.loops[alias]!.cels[0]!.pixels], [0, 2, 1]);
      const engine = engineFor(imported, profile, `set.loop(o0, ${alias});`);
      assert.deepEqual(
        [...engine.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)],
        [15, 2, 1],
      );
    });
  }

  test(`${id}: Studio Add mirror produces the requested pixels beyond the native alias boundary`, () => {
    const count = Math.max(1, limit + 1);
    let document = openViewDocument(
      buildView({ loops: Array.from({ length: count }, () => ({ cels: [cel] })) }, profile),
      profile,
    );
    const result = applyViewEdit(document, { type: "addLoop", at: count, mirrorOf: count - 1 });
    assert.ok("document" in result, "error" in result ? result.error : "");
    document = openViewDocument(buildViewDocument(result.document, profile), profile);
    assert.deepEqual([...document.loops[count]!.cels[0]!.pixels], [0, 2, 1]);
    const view = parseView(document.payload, profile);
    for (let repeat = 0; repeat < 3; repeat++)
      assert.deepEqual([...selectViewCel(view, count, 0)!.pixels], [0, 2, 1]);
  });
}

test("nonpacked SetLoop and SetCel dimension reads do not orient a cel before its first blit", () => {
  // Three native aliases, all pointing to loop 0. Direct loop 2 mirrors once;
  // visiting loop 1 first must not mirror the rows before loop 2's blit.
  const pair = buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] });
  const payload = Uint8Array.from([0, 0, 3, 0, 0, 11, 0, 11, 0, 11, 0, ...pair.slice(9)]);
  for (const selection of [
    "set.loop(o0, 2);",
    "set.loop(o0, 1); set.cel(o0, 0); set.loop(o0, 2);",
  ]) {
    const engine = engineFor(payload, PROFILES["2.936"], selection);
    assert.deepEqual([...engine.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)], [15, 2, 1]);
  }
});

test("Agent write_view preserves mirror intent for a profile with no native mirrors", () => {
  const container = openContainer(new Map(), { profile: PROFILES["2.001"] });
  const state = createAgentSessionState(container, PROFILES["2.001"]);
  const written = executeAgentTool(state, "write_view", {
    num: 1,
    source: "view\ncel a 3 1 0\n12.\nendcel\nloop 0 a\nloop 1 mirror 0\nendview",
  });
  assert.equal(written.success, true, written.error ?? "tool failed");
  const payload = state.container.getResource("view", 1)!;
  assert.deepEqual(
    [...selectViewCel(parseView(payload, PROFILES["2.001"]), 1, 0)!.pixels],
    [0, 2, 1],
  );
  const document = openViewDocument(payload, PROFILES["2.001"]);
  assert.deepEqual([...document.loops[1]!.cels[0]!.pixels], [0, 2, 1]);
});

for (const id of ["2.001", "2.411", "2.936", "2.230"] as const) {
  test(`${id}: three authored facings and mirror chains keep their art through arbitrary selection order`, () => {
    const profile = PROFILES[id];
    const payload = buildView(
      { loops: [{ cels: [cel] }, { mirrorLoop: 0 }, { mirrorLoop: 0 }, { mirrorLoop: 1 }] },
      profile,
    );
    const view = parseView(payload, profile);
    for (const loop of [0, 1, 2, 1, 0, 2, 3, 2, 0, 3])
      assert.deepEqual(
        [...selectViewCel(view, loop, 0)!.pixels],
        loop === 1 || loop === 2 ? [0, 2, 1] : [1, 2, 0],
      );
  });

  test(`${id}: add.to.pic orients each native stamp at its blit boundary`, () => {
    const profile = PROFILES[id];
    const payload = buildView(
      { loops: [{ cels: [cel] }, { mirrorLoop: 0 }] },
      PROFILES[id === "2.230" ? "2.230" : "2.936"],
    );
    const engine = engineFor(
      payload,
      profile,
      `set.loop(o0, 1);
      add.to.pic(1, 0, 0, 30, 90, 15, 4);
      add.to.pic(1, 1, 0, 40, 90, 15, 4);
      add.to.pic(1, 0, 0, 50, 90, 15, 4);`,
    );
    const image = engine.getFrame().visual;
    for (const x of [30, 50])
      assert.deepEqual([...image.slice(90 * 160 + x, 90 * 160 + x + 3)], [1, 2, 15]);
    assert.deepEqual(
      [...image.slice(90 * 160 + 40, 90 * 160 + 43)],
      id === "2.001" ? [1, 2, 15] : [15, 2, 1],
    );
  });
}

test("packed SetLoop preserves native history while SetCel only refreshes dimensions", () => {
  const profile = PROFILES["2.230"];
  const pair = buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] }, profile);
  const three = Uint8Array.from([0, 0, 3, 0, 0, 11, 0, 11, 0, 11, 0, ...pair.slice(9)]);
  const direct = engineFor(three, profile, "set.loop(o0, 2);");
  const via = engineFor(three, profile, "set.loop(o0, 1); set.loop(o0, 2);");
  assert.deepEqual([...direct.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)], [15, 2, 1]);
  assert.deepEqual([...via.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)], [1, 2, 15]);
  // At loop 4 the packed field cannot retain the index. SetCel must not
  // accidentally perform another SetLoop and toggle the whole block again.
  const five = Uint8Array.from([
    0,
    0,
    5,
    0,
    0,
    15,
    0,
    15,
    0,
    15,
    0,
    15,
    0,
    15,
    0,
    ...pair.slice(9),
  ]);
  const sameCel = engineFor(five, profile, "set.loop(o0, 4); set.cel(o0, 0);");
  assert.deepEqual([...sameCel.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)], [15, 2, 1]);
});

for (const id of ["2.411", "2.936", "2.230"] as const) {
  test(`${id}: editing an imported shared block whose orientation names neither member keeps both displayed facings`, () => {
    const profile = PROFILES[id];
    const original = buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] }, profile);
    // Two loops at offset 9, one cel at 12. Orientation 2 names neither
    // member, so each fresh native preview starts reversed: [0,2,1].
    if (profile.packedViewLoopHeader) original[9] = 0xe1;
    else original[14] = 0xa0;
    const document = openViewDocument(original, profile);
    assert.deepEqual(
      buildViewDocument(document, profile),
      original,
      "untouched bytes remain native",
    );
    const result = applyViewEdit(document, {
      type: "setPixels",
      loop: 0,
      cel: 0,
      changes: [{ x: 0, y: 0, color: 3 }],
      propagate: true,
    });
    assert.ok("document" in result, "error" in result ? result.error : "");
    const view = parseView(result.document.payload, profile);
    for (const loop of [0, 1, 0, 1])
      assert.deepEqual([...selectViewCel(view, loop, 0)!.pixels], [3, 2, 1]);
  });
}

for (const operation of ["patch", "restore"] as const) {
  test(`packed loop orientation is rebound after ${operation}`, () => {
    const profile = PROFILES["2.230"];
    const payload = buildView({ loops: [{ cels: [cel] }, { mirrorLoop: 0 }] }, profile);
    const engine = engineFor(payload, profile, "set.loop(o0, 1);");
    const row = () => [...engine.getFrame().visual.slice(80 * 160 + 20, 80 * 160 + 23)];
    assert.deepEqual(row(), [15, 2, 1]);
    if (operation === "patch") engine.patchResources([{ kind: "view", num: 1, payload }]);
    else {
      const image = engine.recordingImage(true);
      assert.ok(image, "the native resource replay fits its buffer");
      engine.restoreImage(image);
    }
    assert.deepEqual(row(), [15, 2, 1]);
  });
}

test("editing a high packed loop does not retain metadata that arms mirroring on selection", () => {
  const profile = PROFILES["2.230"];
  const original = buildView(
    { loops: Array.from({ length: 5 }, () => ({ cels: [cel] })) },
    profile,
  );
  const at = original[13]! | (original[14]! << 8);
  original[at] = 0x81; // mutable, initially not mirrorable, one cel
  const document = openViewDocument(original, profile);
  assert.deepEqual(buildViewDocument(document, profile), original);
  const result = applyViewEdit(document, {
    type: "setPixels",
    loop: 4,
    cel: 0,
    changes: [{ x: 0, y: 0, color: 3 }],
  });
  assert.ok("document" in result, "error" in result ? result.error : "");
  const view = parseView(result.document.payload, profile);
  for (let repeat = 0; repeat < 4; repeat++)
    assert.deepEqual([...selectViewCel(view, 4, 0)!.pixels], [3, 2, 0]);
});

test("view-sheet compilation carries the native mirror capabilities", () => {
  const profile = PROFILES["2.001"];
  const payload = buildViewFromSheet(
    [{ width: 3, height: 1, pixels: Uint8Array.of(1, 2, 0), mask: Uint8Array.of(1, 1, 0) }],
    { loops: [{ frames: [0] }, { mirrorOf: 0 }] },
    profile,
  );
  assert.deepEqual([...selectViewCel(parseView(payload, profile), 1, 0)!.pixels], [0, 2, 1]);
});

for (const id of ["2.936", "2.411"] as const) {
  test(`${id}: editing another loop keeps an untouched native alias group's offsets and header`, () => {
    const profile = PROFILES[id];
    const count = id === "2.936" ? 4 : 6;
    const members = id === "2.936" ? [0, 1, 2] : [0, 4];
    const plain = encodeViewBlocks(
      {
        loops: Array.from({ length: count }, (_, index) =>
          index !== 0 && members.includes(index) ? { mirrorLoop: 0 } : { cels: [cel] },
        ),
      },
      profile,
    );
    const offset = (bytes: Uint8Array, loop: number) =>
      bytes[5 + loop * 2]! | (bytes[6 + loop * 2]! << 8);
    // Native aliasing, deliberately outside the builder's stable sharing rules.
    const start = offset(plain, 0);
    plain[start + 5] = 0x80;
    const document = openViewDocument(plain, profile);
    const result = applyViewEdit(document, {
      type: "setPixels",
      loop: count - 1,
      cel: 0,
      changes: [{ x: 0, y: 0, color: 3 }],
    });
    assert.ok("document" in result, "error" in result ? result.error : "");
    const edited = result.document.payload;
    assert.deepEqual(
      Array.from({ length: count }, (_, index) => offset(plain, index)),
      id === "2.936" ? [13, 13, 13, 22] : [17, 26, 35, 44, 17, 53],
    );
    for (let index = 0; index < count; index++)
      assert.equal(offset(edited, index), offset(plain, index));
    assert.deepEqual(edited.slice(start, start + 9), plain.slice(start, start + 9));
    assert.deepEqual(
      [...openViewDocument(edited, profile).loops[count - 1]!.cels[0]!.pixels],
      [3, 2, 0],
    );
  });
}
