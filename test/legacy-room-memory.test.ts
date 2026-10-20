import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { decodeSave } from "../src/runtime/persistence.ts";
import { buildView } from "../src/view/view.ts";
import { releasedTemplates } from "./released-template-fixtures.ts";
const source =
  releasedTemplates.at(-1)!.source.replaceAll("f200", "f199") +
  "\nif (isset(f230)) { set(f16); restart.game(); }";
const host = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};
function game(logic0 = source) {
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(logic0, { dictionary: new Map() }).payload);
  c.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) { load.pic(1); draw.pic(1); load.view(1); ${"add.to.pic(1,0,0,0,0,9,0);".repeat(12)} } return;`,
      { dictionary: new Map() },
    ).payload,
  );
  c.putResource(
    "logic",
    5,
    assembleLogic("script.size(120); return;", { dictionary: new Map() }).payload,
  );
  c.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  c.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  return c;
}
const capacity = (e: Engine) => decodeSave(e.serialize(), e.profile).replayCapacity;
test("legacy f199 boot with a later room resize starts at 200, restarts, saves and restores blue", () => {
  const e = new Engine(game(), host, new Map(), { legacyRoomMemory: true });
  assert.equal(capacity(e), 200);
  for (let n = 0; n < 4; n++) e.tick();
  assert.ok(decodeSave(e.serialize(), e.profile).replayActive > 50);
  const restored = new Engine(game(), host, new Map(), { legacyRoomMemory: true });
  restored.restoreImage(e.serialize());
  assert.equal(capacity(restored), 200);
  assert.equal(restored.surface.visual[100], 1);
  e.flags[230] = 1;
  e.tick();
  assert.equal(capacity(e), 200);
  assert.doesNotThrow(() => {
    e.tick();
    e.tick();
  });
});
test("an executed smaller declaration retains native meaning; originals start at 50", () => {
  const e = new Engine(game("script.size(120); return;"), host, new Map(), {
    legacyRoomMemory: true,
  });
  e.tick();
  assert.equal(capacity(e), 120);
  const r = new Engine(game(), host, new Map(), { legacyRoomMemory: true });
  r.restoreImage(e.serialize());
  assert.equal(capacity(r), 120);
  assert.equal(capacity(new Engine(game(), host)), 50);
});

test("live legacy edits retain an explicit smaller declaration; removing it raises capacity without clearing replay", () => {
  const e = new Engine(game("script.size(120); return;"), host, new Map(), {
    legacyRoomMemory: true,
    adoptDeclaredScriptSize: true,
  });
  e.tick();
  const explicit = game("script.size(120); assignn(v42,1); return;");
  assert.equal(
    e.commitPreviewUpdate(e.preparePreviewUpdate({ files: explicit.files })).status,
    "committed",
  );
  assert.equal(capacity(e), 120);
  const missing = game("assignn(v42,2); return;");
  assert.equal(
    e.commitPreviewUpdate(e.preparePreviewUpdate({ files: missing.files })).status,
    "committed",
  );
  assert.equal(capacity(e), 200);
});

test("a legacy save without a capacity starts at 200; a larger saved allocation is retained", async () => {
  const { encodeSave } = await import("../src/runtime/persistence.ts");
  const initial = new Engine(game("return;"), host);
  const state = decodeSave(initial.serialize(), initial.profile);
  state.replayCapacity = 0;
  state.replay = [];
  const restored = new Engine(game("return;"), host, new Map(), { legacyRoomMemory: true });
  restored.restoreImage(encodeSave(state, initial.profile));
  assert.equal(capacity(restored), 200);
  const larger = new Engine(game("script.size(240); return;"), host);
  larger.tick();
  restored.restoreImage(larger.serialize());
  assert.equal(capacity(restored), 240);
});
