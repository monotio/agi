/**
 * Sprite Studio's composables and pure helpers on the tutorial's real
 * apprentice (VIEW 0: loop 0 walks right, loop 1 mirrors it). Expected
 * pixels are read from the decoded document and placed by hand here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ref } from "vue";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import {
  buildSprite,
  openSprite,
  samePixels,
  type SpriteCel,
  type SpriteDocument,
} from "../../src/view/spriteDocument.ts";
import { applySpriteEdit } from "../../src/studio/sprite/spriteOperations.ts";
import { validateSpriteEdit } from "../../src/studio/sprite/spriteValidation.ts";
import { testRevision } from "./identity.ts";
import { spriteKey, type SpriteKeyActions } from "../src/studio/sprite/spriteKeys.ts";
import { plainSpriteRefusal } from "../src/studio/sprite/spriteMessages.ts";
import {
  recolorCount,
  recolorEdit,
  recolorTargets,
  type RecolorEdit,
} from "../src/studio/sprite/spriteRecolor.ts";
import {
  backdropCells,
  backdropKey,
  celIntervalMs,
  DEFAULT_BACKDROP,
  feetWarning,
  parseBackdrop,
  paceWords,
  previewPacing,
  type SpriteBackdrop,
  loopFacing,
  moveSelectionChanges,
  previewPartner,
  swatchInk,
} from "../src/studio/sprite/spriteView.ts";
import { celRgba } from "../src/render/palette.ts";
import { usageText } from "../../src/agent/viewUsage.ts";
import { useSpriteDraft } from "../src/studio/sprite/useSpriteDraft.ts";
import { useSpriteTools } from "../src/studio/sprite/useSpriteTools.ts";
import { contentFitZoom } from "../src/studio/useStudioViewport.ts";

// spriteKeys reads the event target's element type; Node has no DOM.
globalThis.HTMLElement ??= class {} as unknown as typeof HTMLElement;

const APPRENTICE = openContainer(new Map(Object.entries(buildTutorial().files))).getResource(
  "view",
  0,
)!;
const at = (cel: SpriteCel, x: number, y: number) => cel.pixels[y * cel.width + x]!;
const celOf = (document: SpriteDocument, loop: number, cel = 0) => document.loops[loop]!.cels[cel]!;

function setup() {
  const base = ref({ bytes: APPRENTICE, revision: testRevision("sprite") });
  const draft = useSpriteDraft({ base, profile: DEFAULT_V2_PROFILE });
  return { draft, base };
}

describe("useSpriteDraft", () => {
  it("opens on the stored bytes and copies a mirrored loop on write", () => {
    const { draft } = setup();
    assert.equal(draft.bytes.value, draft.document.value.original);
    assert.deepEqual(draft.bytes.value, APPRENTICE);
    assert.equal(draft.document.value.loops[1]!.alias, 0);
    const before = draft.document.value;
    const outcome = draft.apply(
      {
        op: { type: "setPixels", loop: 1, cel: 0, changes: [{ x: 4, y: 12, color: 4 }] },
        targets: [1],
      },
      "Pencil",
    );
    assert.deepEqual(outcome, { ok: true, isolated: [1] });
    const after = draft.document.value;
    assert.equal(after.loops[1]!.alias, null);
    assert.equal(at(celOf(after, 1), 4, 12), 4);
    // Loop 0 displays exactly what it did, and so does every other loop.
    for (const loop of [0, 2, 3])
      after.loops[loop]!.cels.forEach((cel, index) =>
        assert.ok(samePixels(cel.pixels, before.loops[loop]!.cels[index]!.pixels)),
      );
    assert.equal(draft.dirty.value, true);
    assert.equal(draft.changes.value, 1);
    // One undo returns the opened bytes themselves.
    assert.equal(draft.undo(), true);
    assert.deepEqual(draft.bytes.value, APPRENTICE);
    assert.equal(draft.dirty.value, false);
    assert.equal(draft.redo(), true);
    assert.equal(at(celOf(draft.document.value, 1), 4, 12), 4);
  });

  it("edits a linked group together only when asked, and refuses a change beyond the target loops", () => {
    const { draft } = setup();
    const original = draft.document.value;
    const width = celOf(original, 0).width;
    const change = { x: 2, y: 12, color: 4 } as const;
    // Propagating while claiming only loop 0 as the target: loop 1 would change too.
    const refused = draft.apply(
      {
        op: { type: "setPixels", loop: 0, cel: 0, propagate: true, changes: [change] },
        targets: [0],
      },
      "Pencil",
    );
    assert.equal(refused.ok, false);
    assert.match(
      !refused.ok ? refused.refusal.message : "",
      /would also change loop 1, outside the loop you are editing/,
    );
    assert.equal(draft.document.value, original);
    const outcome = draft.apply(
      {
        op: { type: "setPixels", loop: 0, cel: 0, propagate: true, changes: [change] },
        targets: [0, 1],
      },
      "Pencil",
    );
    assert.deepEqual(outcome, { ok: true, isolated: [] });
    const after = draft.document.value;
    assert.equal(after.loops[1]!.alias, 0, "the loops stay linked");
    assert.equal(at(celOf(after, 0), 2, 12), 4);
    // Loop 1 shows the edit mirrored.
    assert.equal(at(celOf(after, 1), width - 1 - 2, 12), 4);
  });

  it("refuses the transparent colour and says to use the eraser", () => {
    const { draft } = setup();
    const transparent = celOf(draft.document.value, 0).transparent;
    const outcome = draft.apply(
      {
        op: {
          type: "setPixels",
          loop: 2,
          cel: 0,
          changes: [{ x: 1, y: 1, color: transparent }],
        },
        targets: [2],
      },
      "Pencil",
    );
    assert.equal(outcome.ok, false);
    assert.equal(
      !outcome.ok && outcome.refusal.message,
      "The transparent colour can't be painted. Use the eraser to make pixels transparent.",
    );
    assert.equal(draft.changes.value, 0);
  });

  it("makes a stroke one undo step, and a cancelled stroke nothing", () => {
    const { draft } = setup();
    const op = (xs: number[]) => ({
      op: {
        type: "setPixels" as const,
        loop: 2,
        cel: 0,
        changes: xs.map((x) => ({ x, y: 20, color: 4 })),
      },
      targets: [2],
    });
    draft.beginGesture("Pencil");
    draft.moveGesture(op([1]));
    draft.moveGesture(op([1, 2]));
    assert.equal(at(celOf(draft.shown.value, 2), 2, 20), 4, "the preview shows the stroke");
    assert.equal(draft.dirty.value, false, "nothing is recorded mid-stroke");
    draft.endGesture(op([1, 2, 3]), "Pencil");
    assert.equal(draft.changes.value, 1);
    assert.equal(at(celOf(draft.document.value, 2), 3, 20), 4);
    draft.undo();
    assert.deepEqual(draft.bytes.value, APPRENTICE);
    draft.beginGesture("Pencil");
    draft.moveGesture(op([5]));
    draft.cancelGesture();
    assert.deepEqual(draft.bytes.value, APPRENTICE);
    assert.equal(draft.canRedo.value, true, "a cancelled stroke leaves redo alone");
  });

  it("moves a cel to another loop as one undo step, and a refused part changes nothing", () => {
    const { draft } = setup();
    const moved = celOf(draft.document.value, 2, 1);
    const move = [
      { op: { type: "addCel", loop: 3, at: 4, from: { loop: 2, cel: 1 } }, targets: [3] },
      { op: { type: "deleteCel", loop: 2, cel: 1 }, targets: [2] },
    ] as const;
    assert.deepEqual(draft.applyAll(move, "Move cel to loop"), { ok: true, isolated: [] });
    const after = draft.document.value;
    assert.equal(after.loops[2]!.cels.length, 3);
    assert.equal(after.loops[3]!.cels.length, 5);
    assert.ok(samePixels(celOf(after, 3, 4).pixels, moved.pixels));
    assert.equal(draft.changes.value, 1);
    assert.equal(draft.undo(), true);
    assert.deepEqual(draft.bytes.value, APPRENTICE);
    // The delete claims the wrong loop: the check refuses it, and the copy before it goes too.
    const wrong = [move[0], { ...move[1], targets: [3] }];
    assert.equal(draft.applyAll(wrong, "Move cel to loop").ok, false);
    assert.deepEqual(draft.bytes.value, APPRENTICE);
    assert.equal(draft.canRedo.value, true, "a refusal leaves the history alone");
  });

  it("rebases on Keep and discards back to the kept bytes", () => {
    const { draft } = setup();
    const paint = (x: number) =>
      draft.apply(
        {
          op: { type: "setPixels", loop: 3, cel: 0, changes: [{ x, y: 5, color: 1 }] },
          targets: [3],
        },
        "Pencil",
      );
    paint(1);
    draft.markKept(testRevision("kept"));
    const kept = draft.bytes.value;
    assert.equal(draft.dirty.value, false);
    paint(2);
    assert.equal(draft.changes.value, 1);
    draft.discard();
    assert.deepEqual(draft.bytes.value, kept);
    assert.equal(draft.kept.value.revision, testRevision("kept"));
  });
});

describe("useSpriteTools", () => {
  function tools(loop = 2) {
    const { draft } = setup();
    const said: string[] = [];
    const color = ref(4);
    const t = useSpriteTools({
      draft,
      loop: ref(loop),
      cel: ref(0),
      propagate: () => false,
      targets: () => [loop],
      color,
      report: (outcome) => {
        if (!outcome.ok) said.push(outcome.refusal.message);
      },
      say: (notice) => notice && said.push(notice.text),
      frozen: () => false,
    });
    return { draft, t, said, color };
  }

  it("draws a pencil line from the keyboard: pen down, move, pen up, one step", () => {
    const { draft, t } = tools();
    t.arrow(-5, -16, false); // from the centre (5,16) to 0,0
    t.click();
    t.arrow(3, 0, false);
    t.click();
    const cel = celOf(draft.document.value, 2);
    assert.deepEqual(
      [0, 1, 2, 3].map((x) => at(cel, x, 0)),
      [4, 4, 4, 4],
    );
    assert.equal(draft.changes.value, 1);
    assert.equal(draft.gesturing.value, false);
  });

  it("raises the pen-down cue while a stroke is open, from keys or pointer", () => {
    const { t } = tools();
    assert.equal(t.penDown.value, false);
    t.pressAt({ x: 0, y: 0 });
    assert.equal(t.penDown.value, true, "the pointer's pen is down");
    t.release({ x: 0, y: 0 });
    assert.equal(t.penDown.value, false);
    t.click();
    assert.equal(t.penDown.value, true, "Space put the pen down");
    t.click();
    assert.equal(t.penDown.value, false, "the next Space lifted it");
    t.click();
    t.cancel();
    assert.equal(t.penDown.value, false, "Escape lifts it too");
  });

  it("draws a line and a rect with two clicks each, and the eraser writes transparency", () => {
    const { draft, t } = tools();
    t.setTool("line");
    t.pressAt({ x: 0, y: 30 });
    t.hover({ x: 3, y: 30 });
    t.pressAt({ x: 3, y: 30 });
    t.setTool("eraser");
    t.pressAt({ x: 1, y: 30 });
    t.release({ x: 1, y: 30 });
    const cel = celOf(draft.document.value, 2);
    assert.deepEqual(
      [0, 1, 2, 3].map((x) => at(cel, x, 30)),
      [4, cel.transparent, 4, 4],
    );
    assert.equal(draft.changes.value, 2);
  });

  it("selects, moves and copies a selection with the arrows, and Delete clears it", () => {
    const { draft, t } = tools();
    const source = celOf(draft.document.value, 2);
    // The first 2x2 block of opaque pixels whose right neighbours differ from them.
    const opaque = (x: number, y: number) => at(source, x, y) !== source.transparent;
    const cells = Array.from({ length: source.width * source.height }, (_, i) => ({
      x: i % source.width,
      y: Math.floor(i / source.width),
    }));
    const { x, y } = cells.find(
      ({ x, y }) =>
        x < source.width - 2 &&
        y < source.height - 1 &&
        opaque(x, y) &&
        opaque(x + 1, y) &&
        opaque(x, y + 1) &&
        opaque(x + 1, y + 1) &&
        at(source, x + 2, y) !== at(source, x + 1, y),
    )!;
    t.setTool("select");
    t.pressAt({ x, y });
    t.pressAt({ x: x + 1, y: y + 1 });
    assert.deepEqual(t.selection.value, { x, y, width: 2, height: 2 });
    assert.equal(t.nudgeSelection(1, 0, true), true);
    const copied = celOf(draft.document.value, 2);
    assert.equal(at(copied, x + 2, y), at(source, x + 1, y), "the copy lands one pixel right");
    assert.equal(at(copied, x, y), at(source, x, y), "a copy leaves the source");
    assert.deepEqual(t.selection.value, { x: x + 1, y, width: 2, height: 2 });
    assert.equal(t.clearSelection(), true);
    const cleared = celOf(draft.document.value, 2);
    assert.equal(at(cleared, x + 1, y), cleared.transparent);
    assert.equal(at(cleared, x + 2, y + 1), cleared.transparent);
    assert.equal(at(cleared, x, y), at(source, x, y), "outside the selection stays");
    assert.equal(draft.changes.value, 2);
  });

  it("picks a colour with the pipette, and the eraser for a transparent pixel", () => {
    const { t, said, color } = tools();
    t.setTool("pipette");
    t.pressAt({ x: 0, y: 0 });
    assert.equal(t.tool.value, "eraser");
    assert.match(said.at(-1)!, /transparent/);
    t.setTool("pipette");
    t.pressAt({ x: 5, y: 12 });
    assert.notEqual(color.value, 4);
  });

  it("picks the recolour's colour from a pixel, never a transparent one, and puts the tool away", () => {
    const { draft, t, said } = tools();
    t.setTool("select");
    t.setTool("recolor");
    t.pressAt({ x: 0, y: 0 });
    assert.equal(t.recolorFrom.value, null);
    assert.equal(said.at(-1), "That pixel is transparent: pick a coloured pixel to recolour.");
    t.pressAt({ x: 5, y: 12 });
    assert.equal(t.recolorFrom.value, at(celOf(draft.document.value, 2), 5, 12));
    assert.equal(draft.changes.value, 0, "picking changes nothing");
    assert.equal(t.closeRecolor(), true);
    assert.equal(t.tool.value, "select", "back to the tool it was opened from");
    assert.equal(t.closeRecolor(), false);
  });
});

describe("spriteRecolor", () => {
  const document = openSprite(APPRENTICE, DEFAULT_V2_PROFILE);
  const CYAN = 11;
  const BLUE = 1;
  /** The kernel's own account: the loops and pixels the edit changes, checked against `targets`. */
  function kernel(edit: RecolorEdit, targets: readonly number[]) {
    const result = applySpriteEdit(document, edit);
    assert.ok(!("error" in result), "error" in result ? result.error : "");
    const check = validateSpriteEdit(document, result.document, { targetLoops: targets });
    return {
      ok: check.ok,
      loops: [...new Set(check.changedCels.map(({ loop }) => loop))],
      pixels: check.changedCels.reduce((sum, { pixels }) => sum + pixels, 0),
      isolated: result.isolated,
    };
  }

  it("counts one loop's pixels and splits it from its mirror, as the kernel does", () => {
    // Loop 0's four cels hold 39, 33, 39 and 33 cyan pixels (decoded and counted by hand).
    const edit = recolorEdit("loop", { loop: 0, cel: 2 }, CYAN, BLUE, false);
    assert.deepEqual(edit, { type: "recolor", from: CYAN, to: BLUE, scope: "loop", loop: 0 });
    const targets = recolorTargets(document, edit);
    assert.deepEqual(targets, [0]);
    assert.deepEqual(recolorCount(document, edit), {
      pixels: 144,
      cels: 4,
      clash: null,
      copies: [0],
    });
    assert.deepEqual(kernel(edit, targets), { ok: true, loops: [0], pixels: 144, isolated: [0] });
  });

  it("reaches the linked group when edits propagate, and every loop over the view", () => {
    const linked = recolorEdit("loop", { loop: 1, cel: 0 }, CYAN, BLUE, true);
    assert.deepEqual(recolorTargets(document, linked), [0, 1]);
    assert.deepEqual(recolorCount(document, linked), {
      pixels: 288,
      cels: 8,
      clash: null,
      copies: [],
    });
    assert.deepEqual(kernel(linked, [0, 1]), {
      ok: true,
      loops: [0, 1],
      pixels: 288,
      isolated: [],
    });
    // Loops 2 and 3 add 54 in each of their cels.
    const view = recolorEdit("view", { loop: 3, cel: 1 }, CYAN, BLUE, false);
    assert.deepEqual(recolorTargets(document, view), [0, 1, 2, 3]);
    assert.equal(recolorCount(document, view).pixels, 720);
    assert.deepEqual(recolorCount(document, view).copies, []);
    assert.equal(kernel(view, [0, 1, 2, 3]).pixels, 720);
    // Without the right targets the loop check refuses what the kernel did.
    assert.equal(kernel(view, [3]).ok, false);
  });

  it("counts one cel, skips the transparent colour and flags a transparent target", () => {
    const cel = recolorEdit("cel", { loop: 2, cel: 2 }, CYAN, BLUE, false);
    assert.deepEqual(cel.scope, [{ loop: 2, cel: 2 }]);
    assert.deepEqual(recolorTargets(document, cel), [2]);
    assert.equal(recolorCount(document, cel).pixels, 54);
    assert.equal(kernel(cel, [2]).pixels, 54);
    // Transparent pixels are never a colour to change.
    assert.equal(
      recolorCount(document, recolorEdit("loop", { loop: 2, cel: 0 }, 13, 1, false)).pixels,
      0,
    );
    // Colour 13 is every cel's transparent colour: cyan cannot become it, and the kernel agrees.
    const clash = recolorEdit("loop", { loop: 3, cel: 0 }, CYAN, 13, false);
    assert.deepEqual(recolorCount(document, clash).clash, { loop: 3, cel: 0 });
    assert.ok("error" in applySpriteEdit(document, clash));
  });
});

describe("spriteKeys", () => {
  const actions = (log: string[], canvas = true): SpriteKeyActions => ({
    onCanvas: () => canvas,
    dismiss: () => false,
    close: () => log.push("close"),
    arrow: (dx, dy, alt) => log.push(`arrow ${dx},${dy}${alt ? " alt" : ""}`),
    click: () => log.push("click"),
    remove: () => log.push("remove"),
    step: (what, direction) => log.push(`${what} ${direction}`),
    zoom: (step) => log.push(`zoom ${step}`),
    undo: () => log.push("undo"),
    redo: () => log.push("redo"),
    tool: (key) => (log.push(`tool ${key}`), key === "b"),
    ask: () => (log.push("ask"), true),
    keySheet: () => log.push("key sheet"),
  });
  const key = (init: KeyboardEventInit & { key: string; target?: unknown }) =>
    ({ defaultPrevented: false, target: null, repeat: false, ...init }) as unknown as KeyboardEvent;

  it("maps the canvas keys, the cel and loop steps and the rail letters", () => {
    const log: string[] = [];
    const act = actions(log);
    assert.equal(spriteKey(key({ key: "ArrowLeft", shiftKey: true }), act), true);
    assert.equal(spriteKey(key({ key: "ArrowUp", altKey: true }), act), true);
    assert.equal(spriteKey(key({ key: " " }), act), true);
    assert.equal(spriteKey(key({ key: "." }), act), true);
    assert.equal(spriteKey(key({ key: ">" }), act), true);
    assert.equal(spriteKey(key({ key: "z", metaKey: true, shiftKey: true }), act), true);
    assert.equal(spriteKey(key({ key: "B" }), act), true);
    assert.equal(spriteKey(key({ key: "/" }), act), true);
    assert.equal(spriteKey(key({ key: "q" }), act), false);
    assert.equal(spriteKey(key({ key: "Escape" }), act), true);
    assert.deepEqual(log, [
      "arrow -8,0",
      "arrow 0,-1 alt",
      "click",
      "cel 1",
      "loop 1",
      "redo",
      "tool b",
      "ask",
      "tool q",
      "close",
    ]);
  });

  it("leaves Esc in a text field to the field: it blurs, and Studio stays open", () => {
    const log: string[] = [];
    const act = { ...actions(log), dismiss: () => (log.push("dismiss"), false) };
    const field = (tagName: string) =>
      Object.assign(Object.create(HTMLElement.prototype) as HTMLElement, {
        tagName,
        isContentEditable: false,
        blur: () => log.push(`blur ${tagName}`),
      });
    assert.equal(spriteKey(key({ key: "Escape", target: field("INPUT") }), act), true);
    assert.equal(spriteKey(key({ key: "Escape", target: field("SELECT") }), act), true);
    assert.equal(spriteKey(key({ key: "b", target: field("INPUT") }), act), false);
    assert.deepEqual(log, ["blur INPUT", "blur SELECT"]);
    // Off the field, Esc dismisses first and then closes.
    assert.equal(spriteKey(key({ key: "Escape" }), act), true);
    assert.deepEqual(log.slice(2), ["dismiss", "close"]);
  });

  it("leaves arrows, Space and Enter to the focused control off the canvas", () => {
    const log: string[] = [];
    const act = actions(log, false);
    for (const name of ["ArrowDown", " ", "Enter"])
      assert.equal(spriteKey(key({ key: name }), act), false);
    assert.deepEqual(log, []);
  });
});

describe("sprite view helpers", () => {
  it("paces the loop preview at the engine's cycle", () => {
    // v10 = 1: one 50 ms timer increment a cycle; a cycling object advances a cel a cycle.
    assert.equal(celIntervalMs(1), 50);
    assert.equal(celIntervalMs(2), 100);
    assert.equal(celIntervalMs(2, 3), 300);
    // v10 = 0 imposes no wait: the host's 60 Hz poll bounds it.
    assert.equal(celIntervalMs(0), 1000 / 60);
  });

  it("paces the preview by the cycle time of the object showing the view", () => {
    // The tutorial: v10 = 1 (50 ms cycles) and cycle.time(o0, v52) with v52 = 6.
    const ego = { num: 0, view: 0, loop: 0, cycling: true, cycleTime: 6 };
    assert.deepEqual(previewPacing(1, [ego], 0, 1), { intervalMs: 300, cycleTime: 6, object: 0 });
    // Of several, the one on the edited loop wins over ego.
    const guard = { num: 3, view: 0, loop: 1, cycling: true, cycleTime: 2 };
    assert.equal(previewPacing(1, [ego, guard], 0, 1).intervalMs, 100);
    // Standing still, ego keeps the cycle time it walks with.
    assert.equal(previewPacing(1, [{ ...ego, cycling: false }], 0, 0).intervalMs, 300);
    // Animation off (cycle time 0) or another view paces nothing.
    const off = { ...guard, cycleTime: 0 };
    const other = { ...ego, view: 5 };
    assert.deepEqual(previewPacing(2, [off, other], 0, 1), {
      intervalMs: 100,
      cycleTime: 1,
      object: null,
    });
  });

  it("says the preview's pace in plain words: poses and game ticks, never cycles", () => {
    const ego = { intervalMs: 300, cycleTime: 6, object: 0 };
    assert.deepEqual(paceWords(ego, "game"), {
      text: "The hero changes pose every 6 game ticks",
      title:
        "At game speed each pose shows for 300 ms: the hero changes pose every 6 game ticks, at the game's speed setting.",
    });
    assert.equal(
      paceWords({ intervalMs: 50, cycleTime: 1, object: 3 }, "game").text,
      "Object 3 changes pose every game tick",
    );
    const idle = paceWords({ intervalMs: 50, cycleTime: 1, object: null }, "game");
    assert.equal(idle.text, "Not on screen now: a new pose every 50 ms");
    assert.match(idle.title, /nothing on screen uses this view right now/);
    assert.equal(paceWords(ego, "half").text, "Half speed: a new pose every 600 ms");
    for (const pace of ["game", "half"] as const)
      for (const pacing of [ego, { intervalMs: 50, cycleTime: 1, object: null }]) {
        const words = paceWords(pacing, pace);
        assert.doesNotMatch(`${words.text} ${words.title}`, /\bcycles?\b|\bego\b|a cel\b/);
      }
  });

  it("a backdrop is view only: the cel and the view's bytes stay as they were", () => {
    const document = openSprite(APPRENTICE, DEFAULT_V2_PROFILE);
    const cel = celOf(document, 0);
    const before = { pixels: [...cel.pixels], transparent: cel.transparent };
    const visual = new Uint8Array(160 * 168).fill(2);
    const choices: SpriteBackdrop[] = [
      DEFAULT_BACKDROP,
      { kind: "checker", tone: "light" },
      { kind: "colour", colour: 14 },
      { kind: "room" },
    ];
    for (const backdrop of choices) {
      assert.deepEqual(parseBackdrop(backdropKey(backdrop)), backdrop);
      const cells = backdropCells(backdrop, cel.width, cel.height, {
        visual,
        x: 70,
        baselineY: 120,
      });
      const expected = backdrop.kind === "colour" ? 14 : backdrop.kind === "room" ? 2 : undefined;
      if (expected !== undefined) assert.ok(cells.every((value) => value === expected));
      else assert.deepEqual([cells[0], cells[1]], [-1, -2]);
      // The cel draws exactly as before: transparent pixels stay see-through.
      const rgba = new Uint8ClampedArray(cel.width * cel.height * 4);
      celRgba(cel, rgba);
      const hole = cel.pixels.indexOf(cel.transparent);
      assert.equal(rgba[hole * 4 + 3], 0);
    }
    assert.deepEqual({ pixels: [...cel.pixels], transparent: cel.transparent }, before);
    assert.deepEqual(buildSprite(document, DEFAULT_V2_PROFILE), APPRENTICE);
    assert.deepEqual(parseBackdrop("colour-16"), DEFAULT_BACKDROP);
    assert.deepEqual(parseBackdrop(null), DEFAULT_BACKDROP);
  });

  it("warns when the feet move off the baseline", () => {
    const cel = (rows: string[]): SpriteCel => ({
      width: rows[0]!.length,
      height: rows.length,
      transparent: 13,
      pixels: Uint8Array.from(rows.join("").split(""), (c) => (c === "." ? 13 : 1)),
      mirrorBit: false,
      mirrored: false,
      encoding: null,
    });
    const standing = cel(["..", ".#", "##"]);
    assert.equal(feetWarning(standing, cel(["#.", "..", "##"])), null);
    assert.equal(
      feetWarning(standing, cel([".#", "##", ".."])),
      "The feet moved 1 px up of where the game stands the actor. The actor now floats above its baseline.",
    );
    assert.equal(
      feetWarning(standing, cel(["...", "..#", ".##"])),
      "The feet moved 1 px right of where the game stands the actor.",
    );
  });

  it("moves a selection's opaque pixels, clearing the source unless copying", () => {
    const cel = openSprite(APPRENTICE, DEFAULT_V2_PROFILE).loops[2]!.cels[0]!;
    const selection = { x: 3, y: 12, width: 1, height: 1 };
    const moved = moveSelectionChanges(cel, selection, 0, 1, false);
    assert.deepEqual(moved, [
      { x: 3, y: 12, color: null },
      { x: 3, y: 13, color: at(cel, 3, 12) },
    ]);
    assert.deepEqual(moveSelectionChanges(cel, selection, 0, 1, true), [moved[1]]);
  });

  it("names facings, pairs the preview and words usage", () => {
    assert.deepEqual(
      [0, 1, 2, 3].map((loop) => loopFacing(loop, 4)),
      ["Right-facing", "Left-facing", "Front-facing", "Back-facing"],
    );
    assert.equal(loopFacing(2, 3), undefined);
    assert.equal(loopFacing(0, 1), undefined);
    const document = openSprite(APPRENTICE, DEFAULT_V2_PROFILE);
    assert.equal(previewPartner(document, 1), 0);
    assert.equal(previewPartner(document, 2), 3);
    assert.equal(
      usageText({ rooms: [1, 2, 3], logics: [1, 2, 3], dynamic: false }),
      "Used by rooms 1, 2, 3",
    );
    assert.equal(usageText({ rooms: [], logics: [0], dynamic: false }), "Used by logic 0");
    assert.equal(usageText({ rooms: [], logics: [], dynamic: false }), "Not used by any logic");
  });

  it("fits a cel at the largest whole zoom that leaves room for the baseline", () => {
    // 10x32 cel in 884x600: min(floor(836 / 20), floor((552 - 96) / 32)) = 14.
    assert.equal(contentFitZoom(884, 600, { width: 10, height: 32, below: 96 }, 24), 14);
    assert.equal(contentFitZoom(4000, 4000, { width: 10, height: 32 }, 24), 24);
    assert.equal(contentFitZoom(0, 0, { width: 10, height: 32 }, 24), 1);
  });

  it("words the kernel's refusals plainly", () => {
    assert.equal(
      plainSpriteRefusal("cannot delete the last cel of loop 2; delete the loop"),
      "A loop needs at least one cel. Delete the loop instead.",
    );
    assert.equal(
      plainSpriteRefusal("loop 3's cels are not exact mirror images of loop 1's; pass force"),
      "Loop 3 is not an exact mirror of loop 1; replace it to link them.",
    );
    assert.equal(plainSpriteRefusal("something new"), "The view can't be changed that way.");
  });
});

describe("swatch labels", () => {
  it("are black or white per AGI colour, whichever reads at 4.5:1 or better", () => {
    // WCAG relative luminance of each EGA colour, worked by hand: 0x55 is
    // 0.0908 linear, 0xaa 0.402. Dark gray (0.091) takes white at 7.5:1,
    // brown (0.150) white at 5.2:1, light blue (0.156) white at 5.1:1,
    // light red (0.284) black at 6.7:1, cyan (0.317) black at 7.3:1.
    const W = "var(--agi-15)";
    const B = "var(--agi-0)";
    assert.deepEqual(
      Array.from({ length: 16 }, (_, colour) => swatchInk(colour)),
      [W, W, B, B, W, W, W, B, W, W, B, B, B, B, B, B],
    );
  });
});
