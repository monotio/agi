import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  compileProjectDocuments,
  readBindingsDocument,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { validateAuthoringState } from "../src/authoring/authoringState.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { createStarterProject, type StarterKind } from "../src/authoring/starterProject.ts";
import { firstRoomChanges } from "../src/authoring/firstRoom.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedBoilerplate,
  prepareGuidedPlaySound,
  prepareGuidedRespondToCommand,
  type GuidedContext,
  type GuidedOutcome,
  type PreparedGuidedOperation,
} from "../src/authoring/guidedProject.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { openContainer } from "../src/container/container.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const PROFILE = PROFILES["2.936"]!;

/** A draft workspace over a starter seed, mirroring test/guided-project.test.ts. */
function workspace(kind: StarterKind = "starter") {
  const project = createStarterProject(kind);
  const files = Object.fromEntries(project.files());
  const sources: Record<string, string> = {};
  for (const [num, source] of project.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of project.sources.pictures) sources[`picture:${num}`] = source;
  const read = readProjectDocuments({
    files,
    profileId: project.profileId,
    sources,
    bindings: project.bindings,
  });
  assert.deepEqual(read.diagnostics, [], "the seed's own documents must read cleanly");
  const draft = new ProjectDraft(read.documents);
  const ctx: GuidedContext = { draft, files, profileId: project.profileId };
  return { ctx, draft, project };
}

/** A draft workspace over the blank game's first room: no template bindings. */
function firstRoomWorkspace() {
  const blank = createStarterProject("blank");
  const documents = Object.fromEntries(
    firstRoomChanges().map((change) => [change.key, change.content!]),
  );
  const built = compileProjectDocuments({
    files: Object.fromEntries(blank.files()),
    documents,
    profileId: "2.936",
  });
  assert.ok(built.build, "the first room documents must compile");
  const files = Object.fromEntries(built.build.files());
  const sources: Record<string, string> = {};
  for (const key of ["logic:0", "logic:1", "picture:1"]) sources[key] = documents[key] as string;
  const read = readProjectDocuments({
    files,
    profileId: "2.936",
    sources,
    bindings: {},
  });
  assert.deepEqual(read.diagnostics, [], "the first room's documents must read cleanly");
  const draft = new ProjectDraft(read.documents);
  const ctx: GuidedContext = { draft, files, profileId: "2.936" };
  return { ctx, draft };
}
function mustPrepare(outcome: GuidedOutcome) {
  assert.ok(
    outcome.ok,
    `expected a prepared operation, refused: ${outcome.ok === false ? outcome.message : ""}`,
  );
  return outcome;
}

function docText(draft: ProjectDraft, key: string): string {
  const doc = draft.capture().read(key);
  assert.ok(doc, `expected document ${key}`);
  return doc.content as string;
}

class RecordingHost implements EngineHost {
  keys: number[] = [];
  lines: string[] = [];
  printed: string[] = [];
  displayed: string[] = [];
  status: string[] = [];
  waitKey(): number {
    throw new HostWait();
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takeInputLine(): string | null {
    return this.lines.shift() ?? null;
  }
  playSound(): void {}
  soundOutput(): void {}
  saveGame(): boolean {
    return true;
  }
  restoreGame(): Uint8Array | null {
    return null;
  }
  print(text: string): void {
    this.printed.push(text);
  }
  displayAt(row: number, col: number, text: string): void {
    this.displayed.push(text);
  }
  statusLine(text: string): void {
    this.status.push(text);
  }
}

describe("built-in binding markers", () => {
  test("the authoring state keeps an optional builtin marker through validation", () => {
    const state = validateAuthoringState({
      version: 1,
      bindings: { dead: { kind: "flag", num: 202, builtin: true } },
      world: { rooms: {}, facts: {}, quests: {} },
    });
    assert.equal(state.bindings["dead"]!.builtin, true);
    const round = readBindingsDocument(JSON.stringify(state.bindings));
    assert.equal(round["dead"]!.builtin, true);
  });

  test("the starter and boilerplate templates mark every binding built in", () => {
    for (const kind of ["starter", "boilerplate"] as const) {
      const bindings = createStarterProject(kind).bindings;
      assert.ok(Object.keys(bindings).length > 0);
      for (const [name, binding] of Object.entries(bindings))
        assert.equal(binding.builtin, true, `${kind} binding ${name} is built in`);
    }
    assert.deepEqual(createStarterProject("blank").bindings, {});
  });

  test("the guided room picture variable is marked built in", () => {
    const { ctx, draft } = workspace("starter");
    const op = prepareGuidedAddRoom(ctx, {});
    assert.ok(op.ok);
    op.apply();
    const bindings = readBindingsDocument(docText(draft, "bindings"));
    const picVar = Object.entries(bindings).find(
      ([, binding]) => binding.kind === "variable" && binding.builtin,
    );
    assert.ok(picVar, "the picture variable folds under Built-in");
  });

  test("a creator-named flag stays outside Built-in", () => {
    const { ctx } = workspace("starter");
    mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "wave",
        response: "You wave politely.",
      }),
    ).apply();
    const op = prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: "chime_sound",
      on: { type: "command", command: "wave" },
    });
    assert.ok(op.ok);
    const bindings = JSON.parse(
      op.changes.find((change) => change.key === "bindings")!.content as string,
    );
    assert.equal(bindings.cue_done.builtin, true, "the cue flag folds under Built-in");
  });
});

describe("boilerplate parts", () => {
  test("Menus and Save/Restore adds one named shared LOGIC with built-in state", () => {
    const { ctx, draft } = workspace("starter");
    const op: PreparedGuidedOperation = mustPrepare(
      prepareGuidedBoilerplate(ctx, { part: "menus" }),
    );
    assert.equal(op.label, "Add Menus and Save/Restore");
    assert.deepEqual([...op.affectedKeys].sort(), ["bindings", "logic:2"]);
    const source = op.changes.find((change) => change.key === "logic:2")!.content as string;
    assert.match(source, /set\.menu\.item\(m2, C_SAVE\)/);
    assert.match(source, /if \(controller\(C_SAVE\)\) \{ save\.game\(\); \}/);
    const bindings = JSON.parse(
      op.changes.find((change) => change.key === "bindings")!.content as string,
    );
    assert.deepEqual(bindings.menus_logic, { kind: "logic", num: 2, builtin: true });
    assert.equal(bindings.menus_ready.kind, "flag");
    assert.equal(bindings.menus_ready.builtin, true);
    op.apply();
    assert.match(docText(draft, "logic:2"), /submit\.menu\(\);/);
  });

  test("Game over adds a self-contained death LOGIC with allocated state", () => {
    const { ctx } = firstRoomWorkspace();
    const op = mustPrepare(prepareGuidedBoilerplate(ctx, { part: "game-over" }));
    assert.equal(op.label, "Add game over");
    const key = [...op.affectedKeys].find((affected) => affected.startsWith("logic:"))!;
    const source = op.changes.find((change) => change.key === key)!.content as string;
    assert.match(source, /if \(!isset\(dead\)\) \{/);
    assert.match(source, /restore\.game\(\);/);
    const bindings = JSON.parse(
      op.changes.find((change) => change.key === "bindings")!.content as string,
    );
    for (const name of ["game_over_logic", "dead", "game_over_chosen", "game_over_cursor"])
      assert.equal(bindings[name]?.builtin, true, `${name} is built in`);
    assert.ok(bindings.dead.num >= 32, "the dead flag clears the interpreter-owned band");
  });

  test("Score screen compiles to the hand-derived bytes", () => {
    const { ctx, draft } = firstRoomWorkspace();
    const op = mustPrepare(prepareGuidedBoilerplate(ctx, { part: "score" }));
    assert.equal(op.label, "Add score screen");
    op.apply();
    const source = docText(draft, "logic:2");
    // print(m1); return; — 0x65 m1, 0x00. Re-derived from src/logic/opcodes.ts.
    const r = assembleLogic(source, { dictionary: new Map(), profile: PROFILE });
    assert.deepEqual([...r.code], [0x65, 0x01, 0x00]);
    assert.deepEqual(r.messages, ["", "Score: %v3 of %v7"]);
  });

  test("a taken part name suffixes instead of refusing", () => {
    const { ctx, draft } = workspace("starter");
    const before = draft.capture();
    draft.edit(
      "bindings",
      JSON.stringify({
        ...JSON.parse(before.read("bindings")!.content as string),
        menus_logic: { kind: "logic", num: 200 },
      }),
      before.version("bindings"),
    );
    const op = mustPrepare(prepareGuidedBoilerplate(ctx, { part: "menus" }));
    const bindings = JSON.parse(
      op.changes.find((change) => change.key === "bindings")!.content as string,
    );
    assert.equal(bindings.menus_logic.num, 200, "the existing name is untouched");
    assert.ok(bindings.menus_logic_2, "the part takes the next free name");
  });

  test("the game over part runs: death, box, then restart", () => {
    // A blank game's first room plus the game over part, wired as the part's
    // comment instructs: LOGIC 0 re-calls it while dead, the room calls it on
    // said("die").
    const { ctx, draft } = firstRoomWorkspace();
    const before = draft.capture();
    draft.edit("words", JSON.stringify([["die", 100]]), before.version("words"));
    const op = mustPrepare(prepareGuidedBoilerplate(ctx, { part: "game-over" }));
    op.apply();
    const key = op.affectedKeys.find((affected) => affected.startsWith("logic:"))!;
    const num = key.slice(6);
    draft.edit(
      "logic:0",
      docText(draft, "logic:0").replace(
        "call.v(v0);",
        `call.v(v0);\nif (isset(dead)) { call(game_over_logic); }`,
      ),
      draft.capture().version("logic:0"),
    );
    draft.edit(
      "logic:1",
      docText(draft, "logic:1").replace(
        "return;",
        `if (said("die")) { call(game_over_logic); }\nreturn;`,
      ),
      draft.capture().version("logic:1"),
    );
    const built = compileProjectDocuments({
      files: ctx.files,
      documents: Object.fromEntries(
        [...draft.capture().keys].map((documentKey) => [
          documentKey,
          draft.capture().read(documentKey)!.content!,
        ]),
      ),
      profileId: "2.936",
    });
    assert.ok(built.build, "the wired game compiles");
    assert.equal(num, "2", "the part took the first free shared LOGIC");
    const container = openContainer(built.build.files(), { profile: PROFILE });
    const host = new RecordingHost();
    const dictionary = new Map(
      parseWordsTok(container.files.get("WORDS.TOK")!).map(({ word, id }) => [word, id]),
    );
    const engine = new Engine(container, host, dictionary);
    engine.tick();
    assert.equal(engine.vars[0], 1, "booted into Room 1");
    host.lines.push("die");
    engine.tick();
    const deadNum = readBindingsDocument(docText(draft, "bindings"))["dead"]!.num;
    assert.equal(engine.flags[deadNum], 1, "the part marks the player dead");
    assert.ok(host.displayed.includes("You have died."), "the death box is drawn");
    host.keys.push(50); // "2": choose Restart
    engine.tick();
    engine.tick();
    assert.equal(engine.flags[deadNum], 0, "restart cleared the death");
    assert.equal(engine.vars[0], 1, "the game is back in Room 1");
  });
});
