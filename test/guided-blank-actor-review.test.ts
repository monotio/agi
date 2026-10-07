import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareGuidedPlaceHero, type GuidedContext } from "../src/authoring/guidedProject.ts";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";

class ActorHost implements EngineHost {
  keys: number[] = [];
  waitKey(): number {
    return 13;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takeInputLine(): string | null {
    return null;
  }
  playSound(): void {}
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
}

function boilerplateWorkspace() {
  const project = createStarterProject("boilerplate");
  const files = Object.fromEntries(project.files());
  const sources: Record<string, string> = {};
  for (const [num, source] of project.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of project.sources.pictures) sources[`picture:${num}`] = source;
  const read = readProjectDocuments({
    files,
    sources,
    bindings: project.bindings,
    profileId: project.profileId,
  });
  assert.deepEqual(read.diagnostics, []);
  const draft = new ProjectDraft(read.documents);
  const ctx: GuidedContext = { draft, files, profileId: project.profileId };
  return { ctx, draft };
}

function play(ctx: GuidedContext) {
  const built = compileProjectSelection({
    ...ctx,
    keys: ctx.draft.dirtyKeys(),
  });
  const files = built.compiled.files();
  const dictionary = new Map(
    parseWordsTok(files.get("WORDS.TOK")!).map(({ word, id }) => [word, id]),
  );
  const profile = PROFILES[ctx.profileId];
  const host = new ActorHost();
  const engine = new Engine(openContainer(files, { profile }), host, dictionary, { profile });
  for (let cycle = 0; cycle < 6; cycle++) {
    // Acknowledge the template's welcome message through the real modal input.
    if (engine.modalKind === "print") engine.modalKey(13);
    engine.tick();
  }
  return { engine, host };
}

function installExistingView(draft: ProjectDraft): void {
  const view = createStarterProject("starter").sources.views.get(0);
  assert.ok(view);
  const base = draft.capture();
  draft.apply(draft.propose(base, "Draw hero", [{ key: "view:7", content: JSON.stringify(view) }]));
}

test("Boilerplate boots as an actor-free game until an author adds one", () => {
  const { ctx, draft } = boilerplateWorkspace();
  assert.equal(draft.capture().read("view:1"), undefined);
  const { engine } = play(ctx);
  assert.equal(engine.readState().room, 1);
  assert.equal(engine.readState().inputEnabled, true);
  assert.deepEqual(engine.readObjects(), []);
});

test("Place hero installs an existing drawn VIEW into an actor-free room as one undoable edit", () => {
  const { ctx, draft } = boilerplateWorkspace();
  installExistingView(draft);
  const before = draft.capture();
  const roomBefore = before.read("logic:1")!.content;
  const viewBefore = before.read("view:7")!.content;
  const operation = prepareGuidedPlaceHero(ctx, { room: 1, view: 7, x: 100, y: 120 });
  assert.equal(draft.capture().revision, before.revision, "preparing leaves the draft untouched");
  assert.ok(
    operation.ok,
    operation.ok ? "" : `Guided hero installation refused: ${operation.message}`,
  );
  assert.deepEqual(operation.affectedKeys, ["logic:1"]);
  assert.ok(
    operation.showCode.some(({ key, text }) => key === "logic:1" && text.includes("set.view")),
  );
  const transaction = operation.apply();
  const roomAfter = draft.capture().read("logic:1")!.content;
  assert.equal(typeof roomAfter, "string");
  assert.match(roomAfter as string, /animate\.obj\(o0\)/);
  assert.match(roomAfter as string, /load\.view\(7\)/);
  assert.match(roomAfter as string, /set\.view\(o0,\s*7\)/);
  assert.match(roomAfter as string, /position\(o0,\s*100,\s*120\)/);
  assert.match(roomAfter as string, /draw\(o0\)/);
  assert.match(roomAfter as string, /player\.control\(\)/);
  assert.equal(
    draft.capture().read("view:7")!.content,
    viewBefore,
    "placing preserves the drawn VIEW",
  );

  const { engine, host } = play(ctx);
  const ego = engine.readObjects().find(({ num }) => num === 0);
  assert.ok(ego, "the authored setup activates the hero");
  assert.equal(ego.view, 7);
  assert.equal(ego.x, 100);
  assert.equal(ego.y, 120);
  host.keys.push(0x4d00);
  for (let cycle = 0; cycle < 4; cycle++) engine.tick();
  assert.ok(
    engine.readObjects().find(({ num }) => num === 0)!.x > 100,
    "the hero walks to the right",
  );

  draft.undo(transaction.id);
  assert.equal(draft.capture().read("logic:1")!.content, roomBefore);
  assert.equal(draft.capture().read("view:7")!.content, viewBefore);
  assert.deepEqual(
    play(ctx).engine.readObjects(),
    [],
    "Undo returns the room to its actor-free state",
  );
  draft.redo(transaction.id);
  assert.equal(draft.capture().read("logic:1")!.content, roomAfter);
});

test("partial hand-written hero setup stays intact when guided placement refuses", () => {
  const { ctx, draft } = boilerplateWorkspace();
  installExistingView(draft);
  const base = draft.capture();
  const original = base.read("logic:1")!.content as string;
  const partial = original.replace("  accept.input();", "  set.view(o0, 7);\n  accept.input();");
  draft.edit("logic:1", partial, base.version("logic:1"));
  const before = draft.capture();
  const operation = prepareGuidedPlaceHero(ctx, { room: 1, view: 7, x: 100, y: 120 });
  assert.equal(operation.ok, false);
  if (!operation.ok) assert.equal(operation.code, "custom-code");
  assert.equal(draft.capture().revision, before.revision);
  assert.equal(draft.capture().read("logic:1")!.content, partial);
});

for (const statement of [
  "animate.obj(o0);",
  "if (isset(f10)) { set.view(o0, 7); }",
  "set.view.v(o0, v30);",
  "load.view.v(v30);",
]) {
  test(`actor-free placement refuses partial or computed setup: ${statement}`, () => {
    const { ctx, draft } = boilerplateWorkspace();
    installExistingView(draft);
    const base = draft.capture();
    const source = (base.read("logic:1")!.content as string).replace(
      "  accept.input();",
      `  ${statement}\n  accept.input();`,
    );
    draft.edit("logic:1", source, base.version("logic:1"));
    const before = draft.capture();
    const outcome = prepareGuidedPlaceHero(ctx, { room: 1, view: 7, x: 100, y: 120 });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, "custom-code");
    assert.equal(draft.capture().revision, before.revision);
  });
}

for (const [x, y] of [
  [159, 120],
  [100, 30],
  [100, 168],
] as const) {
  test(`actor-free placement validates the hero footprint at ${x},${y}`, () => {
    const { ctx, draft } = boilerplateWorkspace();
    installExistingView(draft);
    const before = draft.capture();
    const outcome = prepareGuidedPlaceHero(ctx, { room: 1, view: 7, x, y });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, "invalid-input");
    assert.equal(draft.capture().revision, before.revision);
  });
}

test("actor-free placement validates the current PICTURE walk barrier", () => {
  const { ctx, draft } = boilerplateWorkspace();
  installExistingView(draft);
  const base = draft.capture();
  draft.edit("picture:1", "pri 0\nfill 0,0\nend\n", base.version("picture:1"));
  const before = draft.capture();
  const outcome = prepareGuidedPlaceHero(ctx, { room: 1, view: 7, x: 100, y: 120 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "invalid-input");
    assert.match(outcome.message, /walk barrier/);
  }
  assert.equal(draft.capture().revision, before.revision);
});

test("actor-free placement asks for a drawn cel instead of installing a transparent VIEW", () => {
  const { ctx, draft } = boilerplateWorkspace();
  const base = draft.capture();
  draft.apply(
    draft.propose(base, "Empty VIEW", [
      {
        key: "view:7",
        content: JSON.stringify({
          loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [0] }] }],
        }),
      },
    ]),
  );
  const outcome = prepareGuidedPlaceHero(ctx, { room: 1, view: 7, x: 100, y: 120 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "missing");
});
