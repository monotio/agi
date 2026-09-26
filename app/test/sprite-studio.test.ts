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
  openSprite,
  samePixels,
  type SpriteCel,
  type SpriteDocument,
} from "../../src/studio/sprite/spriteDocument.ts";
import { testRevision } from "./identity.ts";
import { spriteKey, type SpriteKeyActions } from "../src/studio/sprite/spriteKeys.ts";
import { plainSpriteRefusal } from "../src/studio/sprite/spriteMessages.ts";
import {
  celIntervalMs,
  feetWarning,
  loopFacing,
  moveSelectionChanges,
  previewPartner,
  usageText,
} from "../src/studio/sprite/spriteView.ts";
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
  });
  const key = (init: KeyboardEventInit & { key: string }) =>
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
      "tool q",
      "close",
    ]);
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
      ["Walk right", "Walk left", "Walk toward", "Walk away"],
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
