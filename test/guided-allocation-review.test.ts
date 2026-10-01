import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedPlaySound,
  type GuidedContext,
} from "../src/authoring/guidedProject.ts";
import { openContainer } from "../src/container/container.ts";
import { Engine } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function workspace() {
  const seed = createStarterProject("starter");
  const files = Object.fromEntries(seed.files());
  const sources: Record<string, string> = {};
  for (const [num, source] of seed.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of seed.sources.pictures) sources[`picture:${num}`] = source;
  const read = readProjectDocuments({
    files,
    profileId: seed.profileId,
    sources,
    bindings: seed.bindings,
  });
  assert.deepEqual(read.diagnostics, []);
  const draft = new ProjectDraft(read.documents);
  const ctx: GuidedContext = { draft, files, profileId: seed.profileId };
  return { ctx, draft, seed, files };
}

function addBindings(
  draft: ProjectDraft,
  added: Record<string, { kind: "variable" | "flag"; num: number }>,
): void {
  const before = draft.capture();
  const text = before.read("bindings")?.content;
  assert.equal(typeof text, "string");
  draft.edit(
    "bindings",
    JSON.stringify({ ...JSON.parse(text as string), ...added }),
    before.version("bindings"),
  );
}

test("a guided room preserves a reserved gameplay variable when drawing its picture", () => {
  const { ctx, draft, seed, files } = workspace();
  addBindings(draft, { coins: { kind: "variable", num: 50 } });
  const operation = prepareGuidedAddRoom(ctx, { logicId: 2, pictureId: 2, title: "Safe room" });
  assert.ok(
    operation.ok,
    `the available variable slots allow a guided room: ${operation.ok ? "" : operation.message}`,
  );
  operation.apply();
  const compiled = compileProjectSelection({
    draft,
    files,
    profileId: seed.profileId,
    keys: draft.dirtyKeys(),
  });
  const container = openContainer(compiled.compiled.files(), { profile: PROFILES[seed.profileId] });
  container.putResource(
    "logic",
    0,
    compileProjectLogic("call(2);\nreturn;", {
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
  engine.vars[50] = 7;
  engine.flags[5] = 1;
  engine.tick();
  assert.equal(engine.readState().pictureShown, true);
  assert.equal(engine.readState().vars[50], 7, "drawing the new picture must preserve coins");
});

for (const aliases of [false, true]) {
  test(`a region cue refuses ${aliases ? "aliased" : "identical"} completion and started flags`, () => {
    const { ctx, draft } = workspace();
    addBindings(draft, {
      done: { kind: "flag", num: 60 },
      started: { kind: "flag", num: aliases ? 60 : 61 },
    });
    const source = `// @rule grove "The grove" region
if (!isset(f40) && posn(o0, 20, 100, 60, 130)) {
  set(f40);
}
// @end
return;
`;
    draft.edit("logic:3", source, 0);
    const before = draft.capture();
    const operation = prepareGuidedPlaySound(ctx, {
      room: 3,
      sound: 1,
      on: { type: "region", rule: "grove" },
      flag: "done",
      startFlag: aliases ? "started" : "done",
    });
    assert.equal(
      operation.ok,
      false,
      "sound clears its completion flag, so it cannot hold the started guard",
    );
    assert.equal(draft.capture().revision, before.revision);
    assert.equal(draft.capture().read("logic:3")?.content, source);
  });
}
