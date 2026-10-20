import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import { decodeSave } from "../src/runtime/persistence.ts";
import { ProjectHistory } from "../src/authoring/projectHistory.ts";
import { migrateScriptSize } from "../src/authoring/scriptSizeMigration.ts";
import { BASE_TEMPLATE_LOGIC0_SOURCE } from "../src/authoring/baseTemplate.ts";
import { sha256Hex } from "../src/crypto.ts";

const PRE_125_LOGIC0 = BASE_TEMPLATE_LOGIC0_SOURCE.replace("  script.size(200);\n", "");

test("the base template's logic 0 raises the script buffer on its first cycle", () => {
  assert.ok(PRE_125_LOGIC0.length > 0);
  assert.ok(BASE_TEMPLATE_LOGIC0_SOURCE.includes("  script.size(200);\n"));
  // An authored room baking a dozen details runs where the authentic
  // 50-pair default faults: 12 add.to.pic calls record 48 pairs, the picture
  // and view loads take the rest past 50.
  const container = createContainer();
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  container.putResource("picture", 1, Uint8Array.of(0xff));
  container.putResource(
    "logic",
    0,
    assembleLogic(BASE_TEMPLATE_LOGIC0_SOURCE, { dictionary: new Map() }).payload,
  );
  container.putResource(
    "logic",
    1,
    assembleLogic(
      `if (!isset(f210)) { set(f210); load.pic(1); draw.pic(1);
        load.view(1); ${"add.to.pic(1, 0, 0, 0, 0, 9, 0);".repeat(12)} discard.pic(1); show.pic(); }
        return;`,
      { dictionary: new Map() },
    ).payload,
  );
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  engine.tick();
  assert.equal(engine.vars[0], 1, "the room ran instead of faulting on entry");
});

test("a 1.2.4-shaped project gains exactly one History commit and no more on reopen", () => {
  const documents = { "logic:0": PRE_125_LOGIC0 };
  const history = new ProjectHistory(sha256Hex);
  history.record(documents, { label: "Opened", origin: "template", author: "creator", time: 1 });
  const migrated = migrateScriptSize(documents);
  assert.ok(migrated !== null);
  assert.match(migrated["logic:0"] as string, /set\(f200\);\n {2}script\.size\(200\);/);
  history.record(migrated, {
    label: "Room memory raised for this version",
    origin: "logic",
    author: "creator",
    time: 2,
  });
  const commits = history.capture().commits;
  assert.equal(commits.length, 2);
  assert.equal(commits[1]!.label, "Room memory raised for this version");
  assert.deepEqual(commits[1]!.changed, ["logic:0"]);
  // A reload reads the migrated source: nothing left to add.
  assert.equal(migrateScriptSize(migrated), null);
});

test("a project without an editable logic 0 source is never touched", () => {
  assert.equal(migrateScriptSize({ "logic:0": Uint8Array.of(0x8d) }), null);
  assert.equal(migrateScriptSize({}), null);
  const boot = "if (!isset(f200)) {\n  set(f200);\n";
  assert.equal(
    migrateScriptSize({ "logic:0": `${boot}  script.size(5); // stray resize\n}\nreturn;` }),
    null,
    "an existing call ends the migration",
  );
  assert.equal(
    migrateScriptSize({ "logic:0": `${boot}// script.size(5) only a comment\n}\nreturn;` }),
    null,
    "a partial customized boot is left alone, including comments",
  );
  assert.equal(
    migrateScriptSize({ "logic:0": `${boot}print("never use script.size(5)");\n}\nreturn;` }),
    null,
    "a partial customized boot is left alone, including strings",
  );
});

test("a logic 0 that already drives f200 some other way is left alone", () => {
  const source = "assignn(f200, 1);\nreturn;";
  assert.equal(migrateScriptSize({ "logic:0": source }), null);
});

test("a logic 0 without the template boot shape is left alone", () => {
  assert.equal(migrateScriptSize({ "logic:0": "return;" }), null);
  assert.equal(migrateScriptSize({ "logic:0": 'print("hi");\nreturn;' }), null);
});

const host = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [] as number[],
};
const dict = new Map<string, number>();
// Room 1 draws its picture on entry and bakes a dozen details whenever f220
// is set: 12 add.to.pic calls record 48 pairs on top of the picture and view
// loads, past the authentic 50-pair buffer.
const BUSY_ROOM = `if (isset(f5)) { load.pic(1); draw.pic(1); discard.pic(1); show.pic(); }
if (isset(f220)) { reset(f220); load.pic(1); draw.pic(1);
  load.view(1); ${"add.to.pic(1, 0, 0, 0, 0, 9, 0);".repeat(12)} discard.pic(1); show.pic(); }
if (isset(f221)) { reset(f221); set(f16); restart.game(); }
return;`;
function game(logic0: string) {
  const container = createContainer();
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  container.putResource("picture", 1, Uint8Array.of(0xff));
  container.putResource("logic", 0, assembleLogic(logic0, { dictionary: dict }).payload);
  container.putResource("logic", 1, assembleLogic(BUSY_ROOM, { dictionary: dict }).payload);
  return container;
}
const MIGRATED_LOGIC0 = migrateScriptSize({ "logic:0": PRE_125_LOGIC0 })!["logic:0"] as string;
const capacity = (engine: Engine) => decodeSave(engine.serialize(), engine.profile).replayCapacity;
/**
 * A 1.2.4-shaped authored game whose boot block already ran. The host option
 * gives the template boot shape the migrated buffer from boot on; a run
 * without it keeps the authentic 50 pairs, like a released build's session.
 */
function bootedBeforeMigration(adoptDeclaredScriptSize: boolean) {
  const engine = new Engine(game(PRE_125_LOGIC0), host, dict, {
    adoptDeclaredScriptSize,
    legacyRoomMemory: adoptDeclaredScriptSize,
  });
  for (let i = 0; i < 4; i++) engine.tick();
  assert.equal(engine.vars[0], 1, "the game reached its first room");
  assert.equal(engine.flags[200], 1, "logic 0's boot block already ran");
  assert.equal(
    capacity(engine),
    adoptDeclaredScriptSize ? 200 : 50,
    adoptDeclaredScriptSize
      ? "the host option already gives the template boot shape the migrated buffer"
      : "the 1.2.4 game booted on the authentic 50-pair buffer",
  );
  return engine;
}
function commitMigration(engine: Engine) {
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of game(MIGRATED_LOGIC0).files) files.set(name, bytes.slice());
  assert.equal(
    engine.commitPreviewUpdate(engine.preparePreviewUpdate({ files })).status,
    "committed",
    "the ordinary admission path takes the migration",
  );
}
function bakeDetails(engine: Engine) {
  engine.flags[220] = 1;
  engine.tick();
  assert.equal(engine.flags[220], 0, "the room baked its details");
}

test("an authored game's open session plays a busy room at once after the migration commits", () => {
  const engine = bootedBeforeMigration(true);
  commitMigration(engine);
  assert.equal(capacity(engine), 200, "the running game adopts the declared buffer");
  assert.doesNotThrow(() => bakeDetails(engine), "the busy room runs without a restart");
});

test("without the authored-project option a live commit keeps the running buffer", () => {
  // Original releases, fixtures and walkthrough tapes run without the host
  // option: script.size applies only when the game executes it.
  const engine = bootedBeforeMigration(false);
  commitMigration(engine);
  assert.equal(capacity(engine), 50);
  assert.throws(() => bakeDetails(engine), /exceeded its 50-pair capacity/);
});

test("an unmigrated authored game plays the busy room from boot under the option", () => {
  // A 1.2.4 game only ever opened in Play mode never meets the session
  // migration; the boot-time floor is what lets its busy rooms run there.
  const engine = bootedBeforeMigration(true);
  assert.doesNotThrow(() => bakeDetails(engine), "the busy room runs before any migration commit");
});

test("restart reapplies the authored buffer floor", () => {
  // The boot block's own script.size ran before the restart wiped it; the
  // unmigrated LOGIC 0 has none, so the floor is what restores 200.
  const engine = bootedBeforeMigration(true);
  engine.flags[221] = 1;
  for (let i = 0; i < 5; i++) engine.tick();
  assert.equal(engine.vars[0], 1, "the restarted game reached its first room again");
  assert.equal(capacity(engine), 200, "the restarted game keeps the authored buffer");
  const unflagged = bootedBeforeMigration(false);
  unflagged.flags[221] = 1;
  for (let i = 0; i < 5; i++) unflagged.tick();
  assert.equal(
    capacity(unflagged),
    50,
    "without the option a restart returns to the authentic default",
  );
});

test("the authored buffer floor never lowers a running game's capacity", () => {
  const engine = new Engine(game(MIGRATED_LOGIC0), host, dict, {
    adoptDeclaredScriptSize: true,
    legacyRoomMemory: true,
  });
  for (let i = 0; i < 4; i++) engine.tick();
  assert.equal(capacity(engine), 200, "the migrated boot block ran its script.size(200)");
  const files = new Map<string, Uint8Array>();
  const lower = game(PRE_125_LOGIC0.replace("  set(f200);", "  set(f200);\n  script.size(30);"));
  for (const [name, bytes] of lower.files) files.set(name, bytes.slice());
  assert.equal(
    engine.commitPreviewUpdate(engine.preparePreviewUpdate({ files })).status,
    "committed",
  );
  assert.equal(capacity(engine), 200, "a smaller declared buffer never lowers the capacity");
});

test("resuming a checkpoint written before the migration runs at the declared buffer", () => {
  // A checkpoint stored by a run without the option (a released build, a
  // Play-mode session that never opened Create) carries the authentic 50
  // pairs and a set f200, so LOGIC 0's script.size never runs on this resume;
  // the host option raises the buffer instead.
  const image = bootedBeforeMigration(false).autosaveImage();
  assert.ok(image, "the pre-option session wrote a checkpoint");
  const resumed = new Engine(game(MIGRATED_LOGIC0), host, dict, {
    adoptDeclaredScriptSize: true,
    legacyRoomMemory: true,
  });
  resumed.restoreImage(image);
  assert.equal(capacity(resumed), 200);
  assert.doesNotThrow(() => bakeDetails(resumed), "the busy room runs on the resumed game");
  const unmigrated = new Engine(game(PRE_125_LOGIC0), host, dict, {
    adoptDeclaredScriptSize: true,
    legacyRoomMemory: true,
  });
  unmigrated.restoreImage(image);
  assert.equal(
    capacity(unmigrated),
    50,
    "a saved capacity retains native meaning when no declared size is adopted",
  );
  const original = new Engine(game(MIGRATED_LOGIC0), host, dict);
  original.restoreImage(image);
  assert.equal(capacity(original), 50, "without the option the saved buffer stands");
});

test("a checkpoint written after the migration resumes with the raised buffer", () => {
  const engine = bootedBeforeMigration(true);
  commitMigration(engine);
  engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image);
  const resumed = new Engine(game(MIGRATED_LOGIC0), host, dict);
  resumed.restoreImage(image);
  assert.equal(capacity(resumed), 200, "the saved image itself carries 200");
});
