import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildObjectFile } from "../src/authoring/inventory.ts";
import { buildView } from "../src/view/view.ts";

const MAIN =
  "if (!isset(f200)) { set(f200); new.room(1); } if (v85 == 1) { set.scan.start(); } call(1); return;";
const ROOM = `if (isset(f5)) {
  assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic();
  load.view(1); animate.obj(o0); set.view(o0,1); position(o0,40,100); draw(o0); stop.motion(o0);
  add.to.pic(1,0,0,80,100,0,0);
}
if (v81 == 1) { get(0); assignn(v81,0); }
if (v82 == 1) { position(o0,60,120); assignn(v82,0); }
if (v83 == 1) { set.scan.start(); }
if (v90 == 1) { assignn(v90,0); print("Wait"); }
return;`;
const dictionary = new Map<string, number>();
function view(color: number, loops = 1) {
  return buildView({
    loops: Array.from({ length: loops }, () => ({
      cels: [{ width: 2, height: 2, pixels: [color, color, color, color] }],
    })),
  });
}
function fixture() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(MAIN, { dictionary }).payload);
  container.putResource("logic", 1, assembleLogic(ROOM, { dictionary }).payload);
  container.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 1, 1, 0xff]));
  container.putResource("view", 1, view(14));
  container.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 1 }]));
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      return null;
    },
    takeKeys() {
      return [];
    },
  });
  engine.tick();
  engine.vars[80] = 77;
  engine.flags[80] = 1;
  engine.vars[81] = 1;
  engine.vars[82] = 1;
  engine.tick();
  return engine;
}

test("candidate room re-entry rebuilds baked VIEWs and actors, preserves global state, and lets room LOGIC place the hero", () => {
  const engine = fixture();
  const candidate = openContainer(engine.containerFiles);
  candidate.putResource("view", 1, view(4, 2));
  candidate.putResource("picture", 1, new Uint8Array([0xf0, 2, 0xf8, 1, 1, 0xff]));
  const ordinary = engine.applyPreviewUpdate({ files: candidate.files });
  assert.equal(ordinary.status, "restartRequired");
  assert.equal(ordinary.roomReentry, true);
  assert.equal(engine.getPictureSurface().visual[100 * 160 + 80], 14);
  assert.equal(engine.readState().egoX, 60);
  assert.equal(engine.readState().egoY, 120);
  const plan = engine.prepareRoomReentry({ files: candidate.files });
  assert.equal(engine.commitRoomReentry(plan).status, "committed");
  assert.equal(engine.vars[80], 77);
  assert.equal(engine.flags[80], 1);
  assert.equal(engine.itemLocation(0), 255);
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.vars[1], 1);
  assert.equal(engine.flags[5], 1);
  assert.equal(engine.readState().egoX, 60);
  assert.equal(engine.readState().egoY, 120);
  engine.tick();
  assert.equal(engine.flags[5], 0);
  assert.equal(engine.readState().egoX, 40);
  assert.equal(engine.readState().egoY, 100);
  assert.equal(engine.getPictureSurface().visual[161], 2);
  assert.equal(engine.getPictureSurface().visual[100 * 160 + 80], 4);
  assert.equal(engine.vars[80], 77);
  assert.equal(engine.flags[80], 1);
  assert.equal(engine.itemLocation(0), 255);
});

test("only the current room's scan.start blocker can use room re-entry; LOGIC 0 still requires restart", () => {
  const engine = fixture();
  engine.vars[83] = 1;
  engine.tick();
  const candidate = openContainer(engine.containerFiles);
  candidate.putResource(
    "logic",
    1,
    assembleLogic(ROOM.replace("return;", "assignn(v84,9); return;"), { dictionary }).payload,
  );
  assert.equal(engine.applyPreviewUpdate({ files: candidate.files }).roomReentry, true);
  assert.equal(
    engine.commitRoomReentry(engine.prepareRoomReentry({ files: candidate.files })).status,
    "committed",
  );
  engine.vars[83] = 0;
  engine.tick();
  assert.equal(engine.vars[84], 9);
  engine.vars[85] = 1;
  engine.tick();
  const shared = openContainer(engine.containerFiles);
  shared.putResource(
    "logic",
    0,
    assembleLogic(MAIN.replace("return;", "assignn(v86,9); return;"), { dictionary }).payload,
  );
  const result = engine.commitRoomReentry(engine.prepareRoomReentry({ files: shared.files }));
  assert.equal(result.status, "restartRequired");
  assert.equal(result.roomReentry, undefined);
  assert.match(result.reason!, /logic 0/);
});

test("room re-entry accepts a message wait and refuses a mixed OBJECT rename without writing", () => {
  const engine = fixture();
  engine.vars[90] = 1;
  engine.tick();
  const before = new Map(engine.containerFiles);
  const candidate = openContainer(engine.containerFiles);
  candidate.putResource("view", 1, view(4, 2));
  const plan = engine.prepareRoomReentry({ files: candidate.files });
  assert.equal(engine.commitRoomReentry(plan).status, "committed");
  assert.equal(engine.modalKind, null);
  assert.equal(engine.continuationPending, false);
  assert.notDeepEqual(new Map(engine.containerFiles), before);
  engine.tick();
  const mixed = openContainer(engine.containerFiles);
  mixed.putFile("OBJECT", buildObjectFile([{ name: "coin", startingRoom: 1 }]));
  const installed = new Map(engine.containerFiles);
  assert.equal(
    engine.commitRoomReentry(engine.prepareRoomReentry({ files: mixed.files })).status,
    "restartRequired",
  );
  assert.deepEqual(new Map(engine.containerFiles), installed);
  assert.equal(engine.itemLocation(0), 255);
});

test("a byte-identical room entry seals the waiting message before discarding its continuation", () => {
  const engine = fixture();
  engine.vars[90] = 1;
  engine.tick();
  const plan = engine.prepareRoomReentry({ files: engine.containerFiles });
  let sealed = 0;
  assert.equal(
    engine.commitRoomReentry(plan, () => {
      assert.equal(engine.modalKind, "print");
      assert.equal(engine.continuationPending, true);
      sealed++;
    }).status,
    "committed",
  );
  assert.equal(engine.modalKind, null);
  assert.equal(engine.continuationPending, false);
  assert.equal(sealed, 1);
  assert.equal(engine.flags[5], 1);
});

test("room re-entry discards an armed message pass and keeps execution control for the new entry", () => {
  const engine = fixture();
  engine.setExecutionGate(() => false);
  engine.vars[90] = 1;
  engine.tick();
  assert.equal(engine.modalKind, "print");
  const plan = engine.prepareRoomReentry({ files: engine.containerFiles });
  assert.equal(engine.commitRoomReentry(plan).status, "committed");
  assert.equal(engine.executionControlActive, true);
  assert.equal(engine.continuationPending, false);
  assert.equal(engine.modalKind, null);
  engine.tick();
  assert.equal(engine.flags[5], 0);
  assert.equal(engine.readState().egoX, 40);
});
