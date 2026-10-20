import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLegacyAuthoredProject,
  projectConventions,
  readAuthoringConventions,
} from "../src/authoring/projectConventions.ts";
import { releasedTemplates } from "./released-template-fixtures.ts";
import { migrateScriptSize } from "../src/authoring/scriptSizeMigration.ts";

test("every older unrecognized game keeps its room capacity, including edited imports", () => {
  for (const extra of [
    { imported: true, library: { source: "zip" } },
    {},
    { library: { source: "remix" } },
  ]) {
    const data = { files: {}, ...extra };
    assert.equal(isLegacyAuthoredProject(data), true);
    assert.deepEqual(projectConventions(data), { version: 0, legacyRoomMemory: true });
  }
  for (const data of [
    { files: { AGI: new TextEncoder().encode("Version 2.936\0") } },
    { files: {}, library: { source: "catalog" } },
    { files: {}, authoringConventions: { version: 1 } },
  ])
    assert.equal(isLegacyAuthoredProject(data), false);
  assert.deepEqual(projectConventions({ files: {}, authoringConventions: { version: 0 } }), {
    version: 0,
  });
});

test("numbered menu messages match by text in source upgrades", () => {
  const source = releasedTemplates[0]!.source
    .replace('#message 1 "File"', '#message 101 "File"')
    .replace("set.menu(m1);", "set.menu(m101);");
  assert.ok(
    String(migrateScriptSize({ "logic:0": source })?.["logic:0"]).includes("script.size(200)"),
  );
});

test("copies and exports refuse an unknown conventions version before rewriting it", () => {
  const data = { files: {}, authoringConventions: { version: 2 } };
  assert.throws(() => projectConventions(data), /version/);
  assert.throws(() => readAuthoringConventions({ version: 2 }));
  assert.deepEqual(data.authoringConventions, { version: 2 });
});
