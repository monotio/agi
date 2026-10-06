import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { createStarterProject, type StarterKind } from "../src/authoring/starterProject.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedConnectDoor,
  prepareGuidedPlaceHero,
  prepareGuidedPlaySound,
  prepareGuidedRespondToCommand,
  type GuidedChange,
  type GuidedContext,
  type GuidedCueTarget,
  type GuidedFailureCode,
  type GuidedLineRange,
  type GuidedOperationKind,
  type GuidedRefusal,
  type GuidedSourcePreview,
  type PreparedGuidedOperation,
} from "../src/authoring/guidedProject.ts";
import { parseWordsTok } from "../src/logic/words.ts";

/** A draft workspace over a real starter seed, with its authored sources claimed. */
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
  return { ctx, draft, project, files };
}

function mustPrepare(outcome: ReturnType<typeof prepareGuidedAddRoom>): PreparedGuidedOperation {
  assert.ok(
    outcome.ok,
    `expected a prepared operation, refused: ${outcome.ok === false ? outcome.message : ""}`,
  );
  return outcome;
}

function docText(draft: ProjectDraft, key: string): string {
  const doc = draft.capture().read(key);
  assert.ok(doc, `expected document ${key}`);
  assert.equal(typeof doc.content, "string", `${key} must be source text`);
  return doc.content as string;
}

function roomLines(source: string, marker: string): number {
  return source.split("\n").findIndex((line) => line.includes(marker)) + 1;
}

/** Merge records into the live bindings document, the way an author edit would. */
function bindNames(
  draft: ProjectDraft,
  added: Record<string, { kind: string; num: number }>,
): void {
  const before = draft.capture();
  const text = before.read("bindings")!.content;
  draft.edit(
    "bindings",
    JSON.stringify({ ...JSON.parse(text as string), ...added }),
    before.version("bindings"),
  );
}

describe("guided add room", () => {
  test("allocates the lowest free ids and prepares an ordinary room without touching the draft", () => {
    const { ctx, draft } = workspace("blank");
    const before = draft.capture();
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Moonlit Hall" }));
    assert.equal(draft.capture().revision, before.revision, "prepare must not write");
    assert.deepEqual(
      [...op.affectedKeys].sort(),
      ["bindings", "logic:1", "picture:1", "world"],
      "lowest free ids on the blank seed",
    );
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.equal(
      room,
      `// Moonlit Hall — an empty room. The f5 block runs once on room entry: draw
// the picture.
if (isset(f5)) {
  assignn(pic_num, 1);
  load.pic(pic_num);
  draw.pic(pic_num);
  show.pic();
  accept.input();
}
return;
`,
    );
    const pic = op.changes.find((c) => c.key === "picture:1")!.content as string;
    assert.equal(pic, `# Moonlit Hall — an empty picture. Draw on it or replace it.\nend\n`);
    const world = JSON.parse(op.changes.find((c) => c.key === "world")!.content as string);
    assert.equal(world.rooms["1"].title, "Moonlit Hall");
    assert.deepEqual(world.rooms["1"].exits, {});
    // The picture number rides a freshly allocated variable, not a shared
    // convention slot: bindings reserve pic_num at the lowest free variable.
    const bindingsChange = JSON.parse(
      op.changes.find((c) => c.key === "bindings")!.content as string,
    );
    assert.deepEqual(bindingsChange.pic_num, { kind: "variable", num: 32 });

    const tx = op.apply();
    assert.equal(tx.keys.length, 4);
    assert.match(docText(draft, "logic:1"), /isset\(f5\)/);
    draft.undo(tx.id);
    assert.equal(draft.capture().read("logic:1"), undefined, "undo removes the room");
  });

  test("honors explicit ids and names bindings only when asked", () => {
    const { ctx, draft } = workspace("blank");
    const op = mustPrepare(
      prepareGuidedAddRoom(ctx, {
        logicId: 37,
        pictureId: 91,
        roomName: "hall",
        pictureName: "hall_pic",
      }),
    );
    assert.ok(op.affectedKeys.includes("logic:37"));
    assert.ok(op.affectedKeys.includes("picture:91"));
    assert.match(
      op.changes.find((c) => c.key === "logic:37")!.content as string,
      /assignn\(pic_num, hall_pic\)/,
    );
    op.apply();
    const bindings = JSON.parse(docText(draft, "bindings"));
    assert.deepEqual(bindings.hall, { kind: "logic", num: 37 });
    assert.deepEqual(bindings.hall_pic, { kind: "picture", num: 91 });
    assert.equal(bindings.pic_num.kind, "variable");
    assert.ok(bindings.pic_num.num >= 32, "a free slot above the interpreter band");
  });

  test("refuses occupied and out-of-range ids precisely", () => {
    const { ctx } = workspace("starter");
    const occupied = prepareGuidedAddRoom(ctx, { logicId: 1 });
    assert.equal(occupied.ok, false);
    if (!occupied.ok) {
      assert.equal(occupied.code, "occupied");
      assert.equal(occupied.key, "logic:1");
    }
    const bad = prepareGuidedAddRoom(ctx, { logicId: 0 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "invalid-input");
  });

  test("refuses an id only reserved by a binding, not a document", () => {
    const { ctx, draft } = workspace("starter");
    const bindings = JSON.parse(docText(draft, "bindings"));
    bindings.secret_room = { kind: "logic", num: 37 };
    const version = draft.capture().version("bindings");
    draft.edit("bindings", JSON.stringify(bindings), version);
    const op = prepareGuidedAddRoom(ctx, { logicId: 37 });
    assert.equal(op.ok, false);
    if (!op.ok) assert.equal(op.code, "occupied");
  });

  test("places a supplied existing view as the hero with a runnable entry", () => {
    const { ctx } = workspace("starter");
    const op = mustPrepare(
      prepareGuidedAddRoom(ctx, { heroView: "ego_view", spawn: { x: 76, y: 110 } }),
    );
    const room = op.changes.find((c) => c.key === "logic:2")!.content as string;
    assert.match(room, /animate\.obj\(o0\);/);
    assert.match(room, /load\.view\(ego_view\);\n {2}set\.view\(o0, ego_view\);/);
    assert.match(room, /position\(o0, 76, 110\);\n {2}draw\(o0\);\n {2}player\.control\(\);/);
    assert.match(room, /set\.horizon\(36\);/);
  });

  test("the picture variable avoids slots an in-flight draft source already uses", () => {
    const { ctx, draft } = workspace("starter");
    // An unfinished room draft already writes v32; the picture variable must move past it.
    draft.edit("logic:9", "if (isset(f5)) {\n  assignn(v32, 1);\n", 0);
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const room = op.changes.find((c) => c.key === "logic:2")!.content as string;
    assert.match(
      room,
      /assignn\(pic_num, 2\);\n {2}load\.pic\(pic_num\);\n {2}draw\.pic\(pic_num\);/,
    );
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 33 }, "v32 stays with the draft");
  });

  test("refuses when a draft source's variable access is unprovable", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:9", "lindirectn(v40, 3);\nreturn;\n", 0);
    const op = prepareGuidedAddRoom(ctx, { title: "Safe room" });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "custom-code");
      assert.equal(op.key, "logic:9");
      assert.match(op.message, /indirect variable access/);
    }
  });

  test("a variable binding reservation keeps the picture variable off it", () => {
    const { ctx, draft } = workspace("starter");
    bindNames(draft, { coins: { kind: "variable", num: 32 } });
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 33 }, "coins keeps v32");
  });

  test("the picture variable skips slots used as bare numbers or v0NN spellings", () => {
    const { ctx, draft } = workspace("starter");
    // Plain numeric and leading-zero operands are equally valid var writes.
    draft.edit("logic:9", "assignn(32, 7);\nassignn(v033, 1);\nreturn;\n", 0);
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(
      bindings.pic_num,
      { kind: "variable", num: 34 },
      "v32 (bare) and v33 (v0NN) both stay occupied",
    );
  });

  test("the picture variable respects the valid prefix of an unfinished source", () => {
    const { ctx, draft } = workspace("starter");
    // Unterminated f5 block: the typed assignn still claims v32.
    draft.edit("logic:9", "if (isset(f5)) {\n  assignn(32, 7);\n", 0);
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 33 });
  });

  test("numbers outside state positions do not reserve variable slots", () => {
    const { ctx, draft } = workspace("starter");
    // posn coordinates, a message number and an immediate value are not vars.
    draft.edit(
      "logic:9",
      "if (posn(o0, 20, 100, 60, 130)) {\n  print(m32);\n  assignn(v50, 32);\n}\nreturn;\n",
      0,
    );
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 32 });
  });

  test("a local #define alias reserves the variable it names", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:9", "#define coins 32\nassignn(coins, 7);\nreturn;\n", 0);
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 33 });
  });

  test("a completed #define keeps its variable through an unfinished prefix", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:9", "#define coins 32\nif (isset(f5)) {\n  assignn(coins, 7);\n", 0);
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 33 });
  });

  test("a local #define shadows the external binding of the same name", () => {
    const { ctx, draft } = workspace("starter");
    // Binding says 33, the room's own #define says 35 — the compiler honors
    // the local one, so v32 is free and v35 is occupied.
    bindNames(draft, { coins: { kind: "variable", num: 33 } });
    draft.edit("logic:9", "#define coins 35\nassignn(coins, 7);\nreturn;\n", 0);
    const op = mustPrepare(prepareGuidedAddRoom(ctx, { title: "Safe room" }));
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.pic_num, { kind: "variable", num: 32 });
  });

  test("an invalid or ambiguous alias refuses instead of guessing", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:9", "#define coins\nassignn(coins, 7);\nreturn;\n", 0);
    const bad = prepareGuidedAddRoom(ctx, { title: "Safe room" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "custom-code");
  });

  test("a numeric set() in a draft source still reserves its flag", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:9", "set(32);\nreturn;\n", 0);
    mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "wave",
        response: "You wave politely.",
      }),
    ).apply();
    const op = mustPrepare(
      prepareGuidedPlaySound(ctx, {
        room: 1,
        sound: "chime_sound",
        on: { type: "command", command: "wave" },
      }),
    );
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.deepEqual(bindings.cue_done, { kind: "flag", num: 33 }, "f32 stays with the draft");
  });

  test("refuses a missing hero view and an off-picture spawn", () => {
    const { ctx } = workspace("starter");
    const missing = prepareGuidedAddRoom(ctx, { heroView: 42 });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.code, "missing");
      assert.equal(missing.key, "view:42");
    }
    const offscreen = prepareGuidedAddRoom(ctx, { heroView: 0, spawn: { x: 158, y: 100 } });
    assert.equal(offscreen.ok, false);
    if (!offscreen.ok) assert.equal(offscreen.code, "invalid-input");
  });
});

describe("guided place hero", () => {
  test("rewrites only the position literals of the recognized entry block", () => {
    const { ctx, draft } = workspace("starter");
    const before = docText(draft, "logic:1");
    const op = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 100, y: 130 }));
    const after = op.changes[0]!.content as string;
    assert.equal(
      after,
      before.replace("position(o0, 80, 140)", "position(o0, 100, 130)"),
      "exactly the position arguments change",
    );
    assert.deepEqual(op.affectedKeys, ["logic:1"]);
    const preview = op.showCode.find((p) => p.key === "logic:1")!;
    assert.equal(preview.lines.length, 1);
    assert.equal(preview.lines[0]!.start, roomLines(after, "position(o0, 100, 130)"));
    assert.match(preview.text, /position\(o0, 100, 130\);/);
  });

  test("rebinds the hero view through the room's own literal references", () => {
    const { ctx, draft } = workspace("starter");
    const bindings = JSON.parse(docText(draft, "bindings"));
    bindings.shadow_view = { kind: "view", num: 0 };
    draft.edit("bindings", JSON.stringify(bindings), draft.capture().version("bindings"));
    const before = docText(draft, "logic:1");
    const op = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, view: 0 }));
    const after = op.changes[0]!.content as string;
    assert.equal(
      after,
      before
        .replace("load.view(ego_view)", "load.view(0)")
        .replace("set.view(o0, ego_view)", "set.view(o0, 0)"),
      "only the view references change",
    );
  });

  test("refuses an entry block without a literal ego position", () => {
    const { ctx } = workspace("boilerplate");
    const op = prepareGuidedPlaceHero(ctx, { room: 1, x: 10, y: 100 });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "custom-code");
      assert.equal(op.key, "logic:1");
      assert.match(op.message, /position/);
    }
  });

  test("refuses a doubled or computed ego setup as custom code", () => {
    const { ctx, draft } = workspace("starter");
    const doubled = docText(draft, "logic:1").replace(
      "  position(o0, 80, 140);",
      "  position(o0, 80, 140);\n  position(o0, 10, 140);",
    );
    draft.edit("logic:1", doubled, draft.capture().version("logic:1"));
    const op = prepareGuidedPlaceHero(ctx, { room: 1, x: 5 });
    assert.equal(op.ok, false);
    if (!op.ok) assert.equal(op.code, "custom-code");
  });

  test("refuses an unparseable room without rewriting it", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:1", "if (isset(f5) {\n", draft.capture().version("logic:1"));
    const op = prepareGuidedPlaceHero(ctx, { room: 1, x: 5 });
    assert.equal(op.ok, false);
    if (!op.ok) assert.equal(op.code, "uncompilable");
  });

  test("refuses a position that cannot hold the hero below the horizon", () => {
    const { ctx } = workspace("starter");
    const op = prepareGuidedPlaceHero(ctx, { room: 1, x: 80, y: 30 });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "invalid-input");
      assert.match(op.message, /horizon/);
    }
  });
});

describe("guided respond to command", () => {
  test("adds a plain said handler and registers the new word in one change", () => {
    const { ctx, draft } = workspace("starter");
    const beforeWords = parseWordsTok(draft.capture().read("words")!.content as Uint8Array);
    assert.ok(!beforeWords.some((w) => w.word === "wave"));
    const op = mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "wave",
        response: "You wave politely.",
      }),
    );
    assert.ok(op.affectedKeys.includes("logic:1"));
    assert.ok(op.affectedKeys.includes("words"));
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(
      room,
      /if \(said\("wave"\)\) \{\n {2}print\("You wave politely\."\);\n\}\nreturn;/,
    );
    const words = JSON.parse(op.changes.find((c) => c.key === "words")!.content as string);
    const wave = words.find((e: [string, number]) => e[0] === "wave");
    assert.ok(wave, "wave is registered");
    assert.equal(wave[1], 108, "next free id after the seeded 100-107");
    for (const entry of beforeWords) {
      const kept = words.find((e: [string, number]) => e[0] === entry.word);
      assert.equal(kept?.[1], entry.id, `word '${entry.word}' keeps id ${entry.id}`);
    }
    const preview = op.showCode.find((p) => p.key === "logic:1")!;
    assert.equal(preview.lines[0]!.start, roomLines(room, 'said("wave")'));
    op.apply();
    assert.match(docText(draft, "logic:1"), /if \(said\("look"\)\) \{ print\("You stand/);
  });

  test("keeps existing message numbers while adding a new handler", () => {
    const { ctx, draft } = workspace("starter");
    const source = docText(draft, "logic:1");
    const classic =
      '#message 1 "The clearing."\n' + source.replace(/print\("[^"\n]*"\)/, "print(m1)");
    draft.edit("logic:1", classic, draft.capture().version("logic:1"));
    const op = mustPrepare(
      prepareGuidedRespondToCommand(ctx, { room: 1, command: "sing", response: "La la." }),
    );
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(room, /#message 1 "The clearing\."/);
    assert.match(room, /print\(m1\)/);
    assert.match(room, /said\("sing"\)/);
  });

  test("refuses an existing command unless replacement is explicit", () => {
    const { ctx } = workspace("starter");
    const op = prepareGuidedRespondToCommand(ctx, {
      room: 1,
      command: "look",
      response: "Trees.",
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "conflict");
      assert.ok(op.lines, "the refusal names the existing handler's lines");
    }
  });

  test("replaceExisting rewrites only inline reply text and keeps other handlers", () => {
    const { ctx } = workspace("starter");
    const op = mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "look",
        response: "A quiet clearing.",
        replaceExisting: true,
      }),
    );
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(room, /if \(said\("look"\)\) \{ print\("A quiet clearing\."\); \}/);
    assert.match(room, /said\("listen"\)/);
    assert.equal(op.affectedKeys.includes("words"), false, "no reseeded vocabulary");
  });

  test("replaceExisting rewrites only the reply text and keeps its message number", () => {
    const { ctx, draft } = workspace("starter");
    const source = docText(draft, "logic:1");
    const classic =
      '#message 1 "The clearing."\n' + source.replace(/print\("[^"\n]*"\)/, "print(m1)");
    draft.edit("logic:1", classic, draft.capture().version("logic:1"));
    const op = mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "look",
        response: "A quiet clearing.",
        replaceExisting: true,
      }),
    );
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(room, /#message 1 "A quiet clearing\."/);
    assert.match(room, /if \(said\("look"\)\) \{ print\(m1\); \}/);
    assert.equal(op.affectedKeys.includes("words"), false, "no reseeded vocabulary");
  });

  test("a shorter literal handler does not block a longer command", () => {
    const { ctx, draft } = workspace("starter");
    // said("look") must consume the whole command: a trailing 'north' leaves
    // it unmatched, so the new handler answers the longer command.
    const op = mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "look north",
        response: "Trees.",
      }),
    );
    op.apply();
    const room = docText(draft, "logic:1");
    assert.match(room, /if \(said\("look"\)\) \{ print\("You stand/);
    assert.match(room, /if \(said\("look", "north"\)\) \{\n {2}print\("Trees\."\);\n\}\nreturn;/);
  });

  test("refuses a command an existing wildcard or rest-of-line handler consumes", () => {
    const { ctx, draft } = workspace("starter");
    let current = 'said("look")';
    const rewrite = (pattern: string) => {
      const source = docText(draft, "logic:1");
      draft.edit("logic:1", source.replace(current, pattern), draft.capture().version("logic:1"));
      current = pattern;
    };
    const refuses = (command: string) => {
      const op = prepareGuidedRespondToCommand(ctx, { room: 1, command, response: "Trees." });
      assert.equal(op.ok, false, `'${command}' must conflict against ${current}`);
      if (!op.ok) assert.equal(op.code, "conflict");
    };
    // said(100, 1) is 'look' plus any one word — a same-length wildcard match.
    rewrite("said(100, 1)");
    refuses("look north");
    // said(100, 9999) ends at the rest-of-line terminator on this profile.
    rewrite("said(100, 9999)");
    refuses("look north forest");
    // The assembler's "*" spelling resolves to the same any-word operand.
    rewrite('said("look", "*")');
    refuses("look north");
  });

  test("refuses filler-only commands and oversized replies", () => {
    const { ctx } = workspace("starter");
    const filler = prepareGuidedRespondToCommand(ctx, { room: 1, command: "!!!", response: "x" });
    assert.equal(filler.ok, false);
    if (!filler.ok) assert.equal(filler.code, "invalid-input");
    const long = prepareGuidedRespondToCommand(ctx, {
      room: 1,
      command: "wave",
      response: "x".repeat(600),
    });
    assert.equal(long.ok, false);
    if (!long.ok) assert.equal(long.code, "invalid-input");
  });

  test("escapes quotes and control characters into an authentic message", () => {
    const { ctx } = workspace("starter");
    const op = mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "shout",
        response: 'He said "stop"\nnow.',
      }),
    );
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(room, /print\("He said \\"stop\\"\\nnow\."\);/);
  });
});

describe("guided connect door", () => {
  function twoRooms() {
    const ws = workspace("starter");
    mustPrepare(prepareGuidedAddRoom(ws.ctx, { heroView: "ego_view" })).apply();
    return ws;
  }

  test("writes an annotated posn/new.room exit and a mirrored return with arrival", () => {
    const { ctx, draft } = twoRooms();
    const op = mustPrepare(
      prepareGuidedConnectDoor(ctx, {
        room: 1,
        destination: 2,
        box: { x1: 70, y1: 150, x2: 90, y2: 167 },
        returnDoor: { box: { x1: 90, y1: 150, x2: 110, y2: 167 } },
        arrival: { x: 100, y: 140 },
      }),
    );
    assert.ok(op.affectedKeys.includes("logic:1"));
    assert.ok(op.affectedKeys.includes("logic:2"));
    assert.ok(op.affectedKeys.includes("world"));
    const room1 = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(
      room1,
      /\/\/ @rule door-2 "To room 2" exit\nif \(posn\(o0, 70, 150, 90, 167\)\) \{\n {2}new\.room\(2\);\n\}\n\/\/ @end\nreturn;/,
    );
    const room2 = op.changes.find((c) => c.key === "logic:2")!.content as string;
    assert.match(
      room2,
      /\/\/ @rule door-1 "To room 1" exit\nif \(posn\(o0, 90, 150, 110, 167\)\) \{\n {2}new\.room\(1\);\n\}\n\/\/ @end\nreturn;/,
    );
    assert.match(
      room2,
      /if \(equaln\(v1, 1\)\) \{\n {4}position\(o0, 100, 140\);\n {4}assignn\(v6, 0\);\n {2}\}/,
    );
    // The reciprocal landing drops ego at room 1's own spawn (80,140) and
    // stops carried direction so the forward doorway cannot retrigger.
    assert.match(
      room1,
      /if \(equaln\(v1, 2\)\) \{\n {4}position\(o0, 80, 140\);\n {4}assignn\(v6, 0\);\n {2}\}/,
    );
    const world = JSON.parse(op.changes.find((c) => c.key === "world")!.content as string);
    assert.equal(world.rooms["1"].title, "Meadow");
    assert.equal(world.rooms["1"].exits["door-2"], 2);
    assert.equal(world.rooms["2"].exits["door-1"], 1);
    op.apply();
    assert.match(docText(draft, "logic:2"), /new\.room\(1\)/);
  });

  test("connects arbitrary resource ids", () => {
    const ws = workspace("boilerplate");
    mustPrepare(prepareGuidedAddRoom(ws.ctx, { logicId: 37, pictureId: 40 })).apply();
    const op = mustPrepare(
      prepareGuidedConnectDoor(ws.ctx, {
        room: 1,
        destination: 37,
        box: { x1: 0, y1: 150, x2: 20, y2: 167 },
      }),
    );
    assert.match(op.changes.find((c) => c.key === "logic:1")!.content as string, /new\.room\(37\)/);
    assert.ok(op.affectedKeys.includes("logic:1"));
    assert.ok(
      !op.affectedKeys.includes("logic:37"),
      "one-way connection leaves the destination alone",
    );
  });

  test("refuses a missing destination, a malformed box and a duplicated doorway", () => {
    const { ctx } = workspace("starter");
    const missing = prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 9,
      box: { x1: 0, y1: 0, x2: 10, y2: 10 },
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "missing");
    const bad = prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 2,
      box: { x1: 90, y1: 0, x2: 10, y2: 10 },
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "invalid-input");
  });

  test("refuses a doorway containing the room's own spawn", () => {
    const { ctx } = twoRooms();
    const op = prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 2,
      box: { x1: 60, y1: 120, x2: 100, y2: 150 },
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "conflict");
      assert.match(op.message, /spawn/);
    }
  });

  test("refuses an arrival point inside the return doorway", () => {
    const { ctx } = twoRooms();
    const op = prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 2,
      box: { x1: 70, y1: 150, x2: 90, y2: 167 },
      returnDoor: { box: { x1: 90, y1: 150, x2: 110, y2: 167 } },
      arrival: { x: 100, y: 160 },
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "invalid-input");
      assert.match(op.message, /inside the return doorway/);
    }
  });

  test("refuses the same doorway twice rather than shadowing it", () => {
    const { ctx } = twoRooms();
    mustPrepare(
      prepareGuidedConnectDoor(ctx, {
        room: 1,
        destination: 2,
        box: { x1: 70, y1: 150, x2: 90, y2: 167 },
      }),
    ).apply();
    const op = prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 2,
      box: { x1: 70, y1: 150, x2: 90, y2: 167 },
    });
    assert.equal(op.ok, false);
    if (!op.ok) assert.equal(op.code, "conflict");
  });

  test("refuses a room whose rule annotations are already broken", () => {
    const { ctx, draft } = twoRooms();
    const broken = docText(draft, "logic:1").replace(
      "return;",
      '// @rule stray "Stray" exit\nreturn;',
    );
    draft.edit("logic:1", broken, draft.capture().version("logic:1"));
    const op = prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 2,
      box: { x1: 70, y1: 150, x2: 90, y2: 167 },
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "custom-code");
      assert.match(op.message, /no @end/);
    }
  });
});

describe("guided play sound", () => {
  test("binds a cue to an existing command handler and shows completion handling", () => {
    const { ctx } = workspace("starter");
    mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "wave",
        response: "You wave politely.",
      }),
    ).apply();
    const op = mustPrepare(
      prepareGuidedPlaySound(ctx, {
        room: 1,
        sound: "chime_sound",
        on: { type: "command", command: "wave" },
        completionMessage: "The tune fades.",
      }),
    );
    assert.deepEqual([...op.affectedKeys].sort(), ["bindings", "logic:1"]);
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    // The cue starts before the modal print window opens, matching the seeded convention.
    assert.match(
      room,
      /if \(said\("wave"\)\) \{\n {2}load\.sound\(chime_sound\);\n {2}sound\(chime_sound, cue_done\);\n {2}print\("You wave politely\."\);\n\}/,
    );
    assert.match(
      room,
      /if \(isset\(cue_done\)\) \{\n {2}print\("The tune fades\."\);\n {2}reset\(cue_done\);\n\}\nreturn;/,
    );
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.equal(bindings.cue_done.kind, "flag");
    assert.equal(bindings.cue_done.num, 32, "lowest free flag above the interpreter-owned band");
    assert.equal(bindings.chime_done.num, 204, "seeded reservations untouched");
    op.apply();
  });

  test("refuses a command handler that already owns the sound channel", () => {
    const { ctx } = workspace("starter");
    const op = prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: "chime_sound",
      on: { type: "command", command: "listen" },
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "conflict");
      assert.match(op.message, /already plays a sound/);
    }
  });

  test("refuses a missing sound, an unknown command and an ambiguous one", () => {
    const { ctx } = workspace("starter");
    const noSound = prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: 7,
      on: { type: "command", command: "listen" },
    });
    assert.equal(noSound.ok, false);
    if (!noSound.ok) {
      assert.equal(noSound.code, "missing");
      assert.equal(noSound.key, "sound:7");
    }
    const noCommand = prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: 1,
      on: { type: "command", command: "zzyzx" },
    });
    assert.equal(noCommand.ok, false);
    if (!noCommand.ok) assert.equal(noCommand.code, "missing");
    const noHandler = prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: 1,
      on: { type: "command", command: "key" },
    });
    // "key" may exist in the dictionary but no handler answers it.
    assert.equal(noHandler.ok, false);
    if (!noHandler.ok) assert.equal(noHandler.code, "missing");
  });

  test("binds a region rule and guards against retriggering", () => {
    const { ctx, draft } = workspace("starter");
    const regionRoom = `// Room 3 — test room.
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  accept.input();
}
// @rule grove "The grove" region
if (!isset(f40) && posn(o0, 20, 100, 60, 130)) {
  set(f40);
  print("You found the grove.");
}
// @end
return;
`;
    draft.edit("logic:3", regionRoom, 0);
    const op = mustPrepare(
      prepareGuidedPlaySound(ctx, {
        room: 3,
        sound: 1,
        on: { type: "region", rule: "grove" },
      }),
    );
    const room = op.changes.find((c) => c.key === "logic:3")!.content as string;
    assert.match(
      room,
      /\/\/ @end\nif \(isset\(f40\) && !isset\(cue_started\)\) \{\n {2}set\(cue_started\);\n {2}load\.sound\(1\);\n {2}sound\(1, cue_done\);\n\}/,
    );
    assert.match(room, /if \(isset\(cue_done\)\) \{\n {2}reset\(cue_done\);\n\}\nreturn;/);
    const bindings = JSON.parse(op.changes.find((c) => c.key === "bindings")!.content as string);
    assert.equal(bindings.cue_done.num, 32);
    assert.equal(bindings.cue_started.num, 33);
    assert.equal(bindings.cue_done.kind, "flag");
  });

  test("keeps an explicit existing completion flag when it is genuinely safe", () => {
    const { ctx } = workspace("starter");
    mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "wave",
        response: "You wave politely.",
      }),
    ).apply();
    const op = mustPrepare(
      prepareGuidedPlaySound(ctx, {
        room: 1,
        sound: "chime_sound",
        on: { type: "command", command: "wave" },
        flag: "chime_done",
      }),
    );
    // The seeded f204 binding is reused: no new reservation appears.
    assert.equal(
      op.changes.some((c) => c.key === "bindings"),
      false,
      "an existing flag needs no new reservation",
    );
    const room = op.changes.find((c) => c.key === "logic:1")!.content as string;
    assert.match(room, /sound\(chime_sound, chime_done\);/);
    assert.match(room, /if \(isset\(chime_done\)\) \{\n {2}reset\(chime_done\);\n\}/);
  });

  test("refuses a completion flag that is the region's own latch", () => {
    const { ctx, draft } = workspace("starter");
    const regionRoom = `// Room 3 — test room.
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  accept.input();
}
// @rule grove "The grove" region
if (!isset(f40) && posn(o0, 20, 100, 60, 130)) {
  set(f40);
}
// @end
return;
`;
    draft.edit("logic:3", regionRoom, 0);
    bindNames(draft, { grove_seen: { kind: "flag", num: 40 } });
    const op = prepareGuidedPlaySound(ctx, {
      room: 3,
      sound: 1,
      on: { type: "region", rule: "grove" },
      flag: "grove_seen",
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "conflict");
      assert.match(op.message, /latch/);
      assert.equal(op.key, "logic:3");
    }
    assert.equal(docText(draft, "logic:3"), regionRoom, "the refusal changed nothing");
  });

  test("refuses interpreter-owned flags as cue state", () => {
    const { ctx, draft } = workspace("starter");
    bindNames(draft, { newroom_flag: { kind: "flag", num: 5 } });
    mustPrepare(
      prepareGuidedRespondToCommand(ctx, {
        room: 1,
        command: "wave",
        response: "You wave politely.",
      }),
    ).apply();
    const op = prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: 1,
      on: { type: "command", command: "wave" },
      flag: "newroom_flag",
    });
    assert.equal(op.ok, false);
    if (!op.ok) {
      assert.equal(op.code, "invalid-input");
      assert.match(op.message, /interpreter-owned/);
    }
  });

  test("refuses a region written in custom code without touching it", () => {
    const { ctx, draft } = workspace("starter");
    const custom = `if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  accept.input();
}
// @rule pond "The pond" region
if (!isset(f40) && posn(o0, 20, 100, 60, 130)) {
  set(f40);
  set(f41);
  print("Splash.");
}
// @end
return;
`;
    draft.edit("logic:3", custom, 0);
    const op = prepareGuidedPlaySound(ctx, {
      room: 3,
      sound: 1,
      on: { type: "region", rule: "pond" },
    });
    assert.equal(op.ok, false);
    if (!op.ok) assert.equal(op.code, "custom-code");
  });
});

describe("prepared proposal authority", () => {
  test("a stale base refuses at apply; a replayed proposal refuses again", () => {
    const { ctx, draft } = workspace("starter");
    const op = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 100 }));
    draft.edit(
      "logic:1",
      docText(draft, "logic:1") + "// typed\n",
      draft.capture().version("logic:1"),
    );
    assert.throws(() => op.apply(), /Stale proposal/);
    const fresh = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 100 }));
    fresh.apply();
    assert.throws(() => fresh.apply(), /already applied/);
  });

  test("a proposal cannot apply to a different workspace", () => {
    const a = workspace("starter");
    const b = workspace("starter");
    const op = mustPrepare(prepareGuidedPlaceHero(a.ctx, { room: 1, x: 100 }));
    assert.throws(() => b.draft.apply(op.proposal), /another workspace/);
  });

  test("an unrelated broken in-flight room does not block an independent edit", () => {
    const { ctx, draft } = workspace("starter");
    draft.edit("logic:9", "if (never ", 0);
    const op = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 90 }));
    op.apply();
    assert.match(docText(draft, "logic:1"), /position\(o0, 90, 140\)/);
    assert.equal(
      docText(draft, "logic:9"),
      "if (never ",
      "the broken draft is preserved untouched",
    );
  });

  test("freeform edits elsewhere survive a guided change byte for byte", () => {
    const { ctx, draft } = workspace("starter");
    const boot = docText(draft, "logic:0") + "\n// custom note\n";
    draft.edit("logic:0", boot, draft.capture().version("logic:0"));
    const op = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 90 }));
    op.apply();
    assert.equal(docText(draft, "logic:0"), boot, "unrelated custom source is preserved");
  });
});

describe("guided operation surface", () => {
  test("exposes the reviewable contract the caller renders", () => {
    const { ctx } = workspace("starter");
    const op = mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 90 }));
    const kind: GuidedOperationKind = op.kind;
    assert.equal(kind, "place-hero");
    const changes: readonly GuidedChange[] = op.changes;
    const previews: readonly GuidedSourcePreview[] = op.showCode;
    const ranges: readonly GuidedLineRange[] = previews.flatMap((p) => p.lines);
    assert.ok(changes.length > 0 && ranges.length > 0);
    assert.ok(ranges.every((r) => r.start >= 1 && r.end >= r.start));

    const refusal = prepareGuidedPlaceHero(ctx, { room: 9, x: 90 });
    assert.equal(refusal.ok, false);
    if (!refusal.ok) {
      const failure: GuidedRefusal = refusal;
      const code: GuidedFailureCode = failure.code;
      assert.equal(code, "missing");
    }

    const on: GuidedCueTarget = { type: "command", command: "wave" };
    assert.equal(on.type, "command");
  });
});

test("guided state allocation tolerates inherited action and condition names in drafts", () => {
  for (const name of ["constructor", "toString", "__proto__"])
    for (const call of [`${name}(v40);`, `if (${name}(f40)) { return; }`]) {
      const { ctx, draft } = workspace();
      draft.edit("logic:3", `${call}\nreturn;`, 0);
      const result = prepareGuidedPlaySound(ctx, {
        room: 1,
        sound: "chime_sound",
        on: { type: "command", command: "wave" },
        createCommand: true,
      });
      assert.ok(result.ok, result.ok === false ? result.message : "");
    }
});
