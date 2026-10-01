import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { prepareGuidedAddRoom } from "../src/authoring/guidedProject.ts";
import { openContainer } from "../src/container/container.ts";
import { Engine } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";

for (const operand of ["v032", "32", "coins"]) {
  test(`adding a room preserves a variable used as ${operand} by another dirty logic`, () => {
    const seed = createStarterProject("starter");
    const files = Object.fromEntries(seed.files());
    const sources: Record<string, string> = {};
    for (const [num, text] of seed.sources.logics) sources[`logic:${num}`] = text;
    for (const [num, text] of seed.sources.pictures) sources[`picture:${num}`] = text;
    const read = readProjectDocuments({
      files,
      profileId: seed.profileId,
      sources,
      bindings: seed.bindings,
    });
    assert.deepEqual(read.diagnostics, []);
    const draft = new ProjectDraft(read.documents);
    const custom = `${operand === "coins" ? "#define coins 32\n" : ""}assignn(${operand}, 7);\nreturn;\n`;
    assert.deepEqual(
      [
        ...compileProjectLogic(custom, {
          profile: PROFILES[seed.profileId],
          dictionary: new Map(),
          bindings: {},
        }).assembly.code,
      ],
      [3, 32, 7, 0],
      "the real assembler accepts this variable spelling with the same exact instructions",
    );
    draft.edit("logic:3", custom, 0);
    const operation = prepareGuidedAddRoom(
      { draft, files, profileId: seed.profileId },
      {
        logicId: 2,
        pictureId: 2,
        title: "Another room",
      },
    );
    assert.ok(operation.ok, operation.ok ? "" : operation.message);
    operation.apply();
    assert.equal(draft.capture().read("logic:3")?.content, custom);
    const compiled = compileProjectSelection({
      draft,
      files,
      profileId: seed.profileId,
      keys: draft.dirtyKeys(),
    });
    const container = openContainer(compiled.compiled.files(), {
      profile: PROFILES[seed.profileId],
    });
    container.putResource(
      "logic",
      0,
      compileProjectLogic("call(3);\ncall(2);\nreturn;", {
        profile: PROFILES[seed.profileId],
        dictionary: new Map(),
        bindings: {},
      }).assembly.payload,
    );
    const engine = new Engine(
      container,
      {
        print: () => {},
        displayAt: () => {},
        statusLine: () => {},
        takeKeys: () => [],
        takeInputLine: () => null,
      },
      new Map(),
      { profile: PROFILES[seed.profileId] },
    );
    engine.flags[5] = 1;
    engine.tick();
    assert.equal(engine.readState().pictureShown, true);
    assert.equal(
      engine.readState().vars[32],
      7,
      "picture setup cannot clobber the other logic's variable",
    );
  });
}
