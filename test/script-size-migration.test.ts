import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import { decodeHostImage, decodeSave } from "../src/runtime/persistence.ts";
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
  assert.notEqual(
    migrateScriptSize({ "logic:0": `${boot}// script.size(5) only a comment\n}\nreturn;` }),
    null,
    "a comment is not a script.size call: the migration still applies",
  );
  assert.notEqual(
    migrateScriptSize({ "logic:0": `${boot}print("never use script.size(5)");\n}\nreturn;` }),
    null,
    "a string is not a call either: the migration still applies",
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

test("a checkpoint taken after the admitted migration resumes with the raised capacity", () => {
  // A live logic 0 edit commits the new code without re-running its
  // already-past init block; the committed image's declared script.size still
  // lands on the running game, so progress checkpoints written after the
  // migration restore at the declared capacity rather than the boot default.
  const dict = new Map<string, number>();
  const host = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [] as number[],
  };
  const room = 'if (isset(f5)) { accept.input(); }\nreturn;';
  const game = (logic0: string) => {
    const container = createContainer();
    container.putResource("logic", 0, assembleLogic(logic0, { dictionary: dict }).payload);
    container.putResource("logic", 1, assembleLogic(room, { dictionary: dict }).payload);
    return container;
  };
  const old = game(PRE_125_LOGIC0);
  const migrated = game(migrateScriptSize({ "logic:0": PRE_125_LOGIC0 })!["logic:0"] as string);
  const engine = new Engine(old, host, dict);
  for (let i = 0; i < 4; i++) engine.tick();
  assert.equal(
    decodeSave(engine.serialize(), engine.profile).replayCapacity,
    50,
    "the 1.2.4 game booted on the authentic 50-pair buffer",
  );
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of migrated.files) files.set(name, bytes.slice());
  assert.equal(
    engine.commitPreviewUpdate(engine.preparePreviewUpdate({ files })).status,
    "committed",
    "the ordinary admission path takes the migration",
  );
  for (let i = 0; i < 2; i++) engine.tick();
  const after = decodeSave(engine.serialize(), engine.profile);
  assert.equal(after.replayCapacity, 200, "the running game adopts the declared capacity");
  const image = engine.autosaveImage() ?? engine.serialize();
  const fresh = new Engine(migrated, host, dict);
  fresh.restoreImage(image);
  assert.equal(
    decodeSave(fresh.serialize(), fresh.profile).replayCapacity,
    200,
    "a checkpoint written after the migration resumes at capacity 200",
  );
});
