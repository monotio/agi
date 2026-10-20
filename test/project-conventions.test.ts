import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLegacyAuthoredProject,
  projectConventions,
  readAuthoringConventions,
} from "../src/authoring/projectConventions.ts";
import { gameUpdates, hasReleasedBoot } from "../src/authoring/scriptSizeMigration.ts";
import { releasedTemplates } from "./released-template-fixtures.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { createContainer } from "../src/container/container.ts";
for (const { version, source } of releasedTemplates)
  test(`decoded ${version} boot proves an old playable export was authored here`, () => {
    const c = createContainer();
    c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
    assert.equal(hasReleasedBoot(Object.fromEntries(c.files)), true);
  });
test("workspace alone does not prove authorship, and originals override every claim", () => {
  const files = {};
  assert.equal(
    isLegacyAuthoredProject({ files, imported: true, library: { source: "zip" } }),
    false,
  );
  for (const extra of [
    { library: { source: "authored" } },
    { templateId: "starter" },
    { provider: "stub" },
    { sessionId: "older" },
    {},
  ])
    assert.equal(isLegacyAuthoredProject({ files, ...extra }), true);
  assert.equal(
    isLegacyAuthoredProject({
      files: { AGI: new TextEncoder().encode("Version 2.936\0") },
      authoringConventions: { version: 1, legacyRoomMemory: true },
    }),
    false,
  );
  assert.deepEqual(projectConventions({ files, imported: true }), { version: 1 });
  assert.throws(() => readAuthoringConventions({ version: 2 }));
});
test("legacy feedback notices distinguish released, customized, unrelated and absent replies", () => {
  const source = releasedTemplates.at(-1)!.source;
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  const files = Object.fromEntries(c.files);
  assert.equal(gameUpdates({ "logic:0": source }, files, true).length, 2);
  const custom = source.replace("I don't know the word", "Unknown word");
  assert.equal(
    gameUpdates({ "logic:0": custom }, files, true).find((r) => r.kind === "words")?.source,
    undefined,
  );
  assert.equal(
    gameUpdates({ "logic:0": "word.to.string(s1,1); return;" }, files, true).some(
      (r) => r.kind === "words",
    ),
    false,
  );
  assert.equal(
    gameUpdates({}, files, true).some((r) => r.kind === "words"),
    false,
  );
  assert.deepEqual(gameUpdates({ "logic:0": source }, files, false), []);
});
test("room memory Add can use a proven unused flag, but never indirect flag writes or source-less code", () => {
  const source = "set(f199); call(1); return;";
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  const files = Object.fromEntries(c.files);
  assert.ok(
    gameUpdates({ "logic:0": source }, files, true).find((r) => r.kind === "memory")?.source,
  );
  assert.equal(
    gameUpdates({ "logic:0": "set.v(v40); return;" }, files, true).find((r) => r.kind === "memory")
      ?.source,
    undefined,
  );
  assert.equal(gameUpdates({}, files, true).find((r) => r.kind === "memory")?.source, undefined);
});

test("a proven unused-flag Add compiles as real source; indirect reads prevent allocation", () => {
  const source = "set(f199); call(1); return;";
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  const files = Object.fromEntries(c.files);
  const row = gameUpdates({ "logic:0": source }, files, true).find((row) => row.kind === "memory")!;
  assert.ok(row.source);
  assert.doesNotThrow(() => assembleLogic(row.source!, { dictionary: new Map() }));
  const indirect = "if (isset.v(v40)) { set(f60); } return;";
  assert.equal(
    gameUpdates({ "logic:0": indirect }, files, true).find((row) => row.kind === "memory")?.source,
    undefined,
  );
});

test("Blank, Adventure Department remixes and fresh projects have no update rows", async () => {
  const { createStarterProject } = await import("../src/authoring/starterProject.ts");
  const blank = createStarterProject("blank");
  assert.deepEqual(gameUpdates({}, Object.fromEntries(blank.files()), true), []);
  const { buildTutorial, TUTORIAL_LOGIC_SOURCES } =
    await import("../games/adventure-department/game.ts");
  const tutorial = buildTutorial();
  const docs = Object.fromEntries(
    Object.entries(TUTORIAL_LOGIC_SOURCES).map(([num, source]) => [`logic:${num}`, source]),
  );
  assert.deepEqual(gameUpdates(docs, tutorial.files, true), []);
  const fresh = createStarterProject("starter");
  assert.deepEqual(
    gameUpdates(
      { "logic:0": releasedTemplates.at(-1)!.source },
      Object.fromEntries(fresh.files()),
      false,
    ),
    [],
  );
});

test("numbered menu messages match by text in both source upgrades and playable import eligibility", async () => {
  const source = releasedTemplates[0]!.source
    .replace('#message 1 "File"', '#message 101 "File"')
    .replace("set.menu(m1);", "set.menu(m101);");
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  assert.equal(hasReleasedBoot(Object.fromEntries(c.files)), true);
  const { migrateScriptSize } = await import("../src/authoring/scriptSizeMigration.ts");
  assert.ok(
    String(migrateScriptSize({ "logic:0": source })?.["logic:0"]).includes("script.size(200)"),
  );
});

test("copies and exports refuse an unknown conventions version before rewriting it", () => {
  const data = { files: {}, authoringConventions: { version: 2 } };
  assert.throws(() => projectConventions(data), /version/);
  assert.deepEqual(data.authoringConventions, { version: 2 });
});
