/**
 * Adventure Department's Studio lessons: one per exhibit, each opening the
 * Studio on the resource behind it, with a challenge the app checks. AGI
 * bytecode cannot see the Studio (or read the priority plane), so the game
 * only points here; the checks run on the Studio kernels, comparing the
 * decoded resource before and after the player's edit.
 */
import type { LessonSet, LessonVerifyInput } from "../../app/src/lessons/types.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH, createPictureSurface } from "../../src/types.ts";
import {
  parsePictureDocument,
  pictureCommandText,
  type PictureDocument,
  type PictureItem,
} from "../../src/studio/pictureDocument.ts";
import {
  compileEditDocument,
  footprintMask,
  unionMask,
  validateEdit,
  type CompiledDocument,
} from "../../src/studio/editValidation.ts";
import { itemMask } from "../../src/studio/pictureQuery.ts";
import { openSprite, type SpriteDocument } from "../../src/view/spriteDocument.ts";
import { validateSpriteEdit } from "../../src/studio/sprite/spriteValidation.ts";
import { TUTORIAL_PICTURES } from "./sceneArt.ts";

type Verdict = { readonly ok: boolean; readonly hint?: string };

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
const MURAL = 4;
const SUN = "sun";
const ARCHIVE = 3;
const ROBOT_VIEW = 2;
const COUNTER_PRIORITY = 11;

const fail = (hint: string): Verdict => ({ ok: false, hint });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The picture's planes, decoded straight from its bytes. */
function planes(bytes: Uint8Array, input: LessonVerifyInput) {
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile: input.profile });
  return surface;
}

/**
 * The source the player started from: the Studio's own text, or the shipped
 * source when the bytes are still the shipped picture's.
 */
function beforeDocument(input: LessonVerifyInput): PictureDocument | null {
  const source = input.beforeSource ?? shippedSourceFor(input);
  return source === undefined ? null : parsePictureDocument(source).document;
}

function shippedSourceFor(input: LessonVerifyInput): string | undefined {
  const source = TUTORIAL_PICTURES[input.num];
  if (source === undefined) return undefined;
  const shipped = parsePictureDocument(source).document;
  const bytes = compileEditDocument(shipped, input.profile).bytes;
  return sameBytes(bytes, input.before) ? source : undefined;
}

/** What an item draws: its command lines, as text. */
function itemCommands(document: PictureDocument, item: PictureItem): string {
  return item.commandLines.map((line) => pictureCommandText(document.lines[line - 1]!)).join("\n");
}

/** The ids of items added, removed, re-labelled or whose commands changed. */
function changedItems(before: PictureDocument, after: PictureDocument): string[] {
  const out = new Set<string>();
  const index = (document: PictureDocument) =>
    new Map(document.items.map((item) => [item.id, item] as const));
  const a = index(before);
  const b = index(after);
  for (const [id, item] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.kind !== item.kind ||
      itemCommands(before, item) !== itemCommands(after, other)
    )
      out.add(id);
  }
  for (const id of b.keys()) if (!a.has(id)) out.add(id);
  return [...out];
}

function labelOf(documents: readonly PictureDocument[], id: string): string {
  for (const document of documents) {
    const item = document.items.find((candidate) => candidate.id === id);
    if (item) return item.label;
  }
  return id;
}

function compileOrNull(
  document: PictureDocument,
  input: LessonVerifyInput,
): CompiledDocument | null {
  try {
    return compileEditDocument(document, input.profile);
  } catch {
    return null;
  }
}

/** Challenge 1: change the sun, and only the sun. */
export function verifyMuralObject(input: LessonVerifyInput): Verdict {
  if (input.kind !== "picture" || input.num !== MURAL)
    return fail("This challenge is for the mural, PIC 4. Open it from the lesson.");
  if (sameBytes(input.before, input.after))
    return fail(
      "Nothing has changed yet. Pick Sun in the list, then give it a new colour or a new place.",
    );
  const before = beforeDocument(input);
  if (!before || input.afterSource === undefined)
    return fail("Make this change in Room Studio, so it can see which object you changed.");
  const after = parsePictureDocument(input.afterSource).document;
  if (!after.items.some((item) => item.id === SUN))
    return fail("The sun needs to stay in the sky. Change its colour, size or place.");
  const changed = changedItems(before, after);
  // A new object (a drawn shape, a copy) counts as a change of its own.
  if (changed.some((id) => !before.items.some((item) => item.id === id)))
    return fail("Only the sun should change, and this also added a new shape.");
  const others = changed.filter((id) => id !== SUN);
  if (others.length > 0) {
    const names = others.map((id) => labelOf([after, before], id)).join(", ");
    const removed = others.some((id) => !after.items.some((item) => item.id === id));
    const what = `${removed ? "removed" : "changed"} ${names}`;
    return fail(
      changed.includes(SUN)
        ? `Only the sun should change, and this also ${what}.`
        : `Only the sun should change, but this ${what}. Undo that, then change the sun.`,
    );
  }
  if (changed.length === 0)
    return fail("Your change is outside every named object. Change the sun: pick Sun in the list.");
  const label = labelOf([after, before], SUN);
  const a = compileOrNull(before, input);
  const b = compileOrNull(after, input);
  if (!a || !b) return fail("The recipe has a mistake in it now. Undo your last step.");
  const moved = [...a.visual].some((value, i) => value !== b.visual[i]);
  if (!moved)
    return fail(`${label} changed in the recipe, but not on screen. Try a colour that stands out.`);
  const allowed = unionMask(footprintMask(a, SUN, "both"), footprintMask(b, SUN, "both"));
  const { ok, violations } = validateEdit(a, b, { lockedPlanes: [], allowedMask: allowed });
  if (!ok) {
    const cells = violations.reduce((sum, v) => sum + ("count" in v ? v.count : 0), 0);
    return fail(
      `${cells} pixel${cells === 1 ? "" : "s"} outside ${label} changed too. Keep ${label} clear of the other objects.`,
    );
  }
  return { ok: true };
}

/**
 * Challenge 2: repaint the robot's left-facing loop and leave the right-facing
 * loop alone. The repaint must land in one of loop 1's own cels: adding or
 * removing a cel also breaks the mirror, but repaints nothing.
 */
export function verifyMirrorEdit(input: LessonVerifyInput): Verdict {
  if (input.kind !== "view" || input.num !== ROBOT_VIEW)
    return fail("This challenge is for the waving robot, VIEW 2. Open it from the lesson.");
  let before: SpriteDocument;
  let after: SpriteDocument;
  try {
    before = openSprite(input.before, input.profile);
    after = openSprite(input.after, input.profile);
  } catch {
    return fail("That view cannot be read. Undo your last step.");
  }
  const check = validateSpriteEdit(before, after, { protectedLoops: [0], targetLoops: [1] });
  if (check.changedCels.length === 0 && check.metadata.length === 0)
    return fail(
      "Nothing has changed yet. Pick a cel in loop 1, where he faces left, and repaint his eye.",
    );
  if (check.violations.some((v) => v.constraint === "protected-loop"))
    return fail("The right-facing loop 0 changed too. Undo that: only loop 1 should change.");
  if (!check.ok) return fail("Something outside loop 1 changed. Only the left-facing loop should.");
  const cels = before.loops[1]?.cels.length ?? 0;
  if (after.loops[1]?.cels.length !== cels)
    return fail(
      `Loop 1 should keep its ${cels} cels. Undo the added or removed cel, and repaint one instead.`,
    );
  if (!check.changedCels.some(({ loop, cel }) => loop === 1 && cel < cels))
    return fail("Loop 1 still looks the same. Repaint a pixel in it, like his eye.");
  if (after.loops[1]?.alias !== null)
    return fail("Loop 1 still mirrors loop 0. Edit it so it becomes its own copy.");
  return { ok: true };
}

/** Challenge 3: give the ledger stand the counter's depth without touching the picture. */
export function verifyStandDepth(input: LessonVerifyInput): Verdict {
  if (input.kind !== "picture" || input.num !== ARCHIVE)
    return fail("This challenge is for the archive, PIC 3. Open it from the lesson.");
  if (sameBytes(input.before, input.after))
    return fail("Nothing has changed yet. Switch to the Depth lens and select Counter depth.");
  const a = planes(input.before, input);
  const b = planes(input.after, input);
  if (a.visual.some((value, i) => value !== b.visual[i]))
    return fail(
      "The picture itself changed. This one is depth only: undo, and edit in the Depth lens.",
    );

  // The stand's pixels, from the shipped archive: its art item's visual footprint.
  const shipped = parsePictureDocument(TUTORIAL_PICTURES[ARCHIVE]!).document;
  const reference = compileEditDocument(shipped, input.profile);
  const stand = itemMask(reference, shipped, "ledger-stand", "visual");
  const counter = itemMask(reference, shipped, "counter-depth", "priority");
  let standCells = 0;
  let hidden = 0;
  let x0 = SCREEN_WIDTH;
  let y0 = SCREEN_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < CELLS; i++) {
    if (stand[i] !== 1) continue;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    // Barrier lines (0..3) are control, not depth: they don't count either way.
    if (b.priority[i]! < 4) continue;
    standCells++;
    if (b.priority[i] === COUNTER_PRIORITY) hidden++;
  }
  for (let i = 0; i < CELLS; i++) {
    if (
      counter[i] === 1 &&
      a.priority[i] === COUNTER_PRIORITY &&
      b.priority[i] !== COUNTER_PRIORITY
    )
      return fail(
        "The counter lost some of its depth, so Felix would float again. Undo that part.",
      );
  }
  if (a.priority.some((value, i) => value < 4 && b.priority[i] !== value))
    return fail(
      "That covered a walk barrier, so the apprentice could walk through things. Draw the depth earlier: undo, click Counter depth's last step under Details › Steps (or drag the draw order back before the barriers), and draw it again.",
    );
  let outside = 0;
  for (let i = 0; i < CELLS; i++) {
    if (a.priority[i] === b.priority[i] || counter[i] === 1) continue;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    if (x < x0 - 2 || x > x1 + 2 || y < y0 - 2 || y > y1 + 2) outside++;
  }
  if (outside > 0)
    return fail(
      `${outside} pixels of depth landed away from the ledger stand. Keep it to the stand.`,
    );
  if (hidden < standCells * 0.9) {
    const others = [...b.priority].some((value, i) => stand[i] === 1 && value > COUNTER_PRIORITY);
    return fail(
      others
        ? "Some of the stand is closer than 11 (a bigger number), so it would hide the apprentice standing in front. Use the counter's 11."
        : `The stand isn't covered yet: ${hidden} of its ${standCells} pixels have depth 11. Cover all of it.`,
    );
  }
  const before = beforeDocument(input);
  if (before && input.afterSource !== undefined) {
    const after = parsePictureDocument(input.afterSource).document;
    const notDepth = changedItems(before, after).filter((id) => {
      const item = after.items.find((candidate) => candidate.id === id);
      return item !== undefined && item.kind !== "depth";
    });
    if (notDepth.length > 0)
      return fail(
        `${labelOf([after], notDepth[0]!)} is not a depth object. Put the depth in Counter depth.`,
      );
  }
  return { ok: true };
}

export const TUTORIAL_LESSONS: LessonSet = {
  catalogId: "adventure-department",
  version: "1.2.0",
  title: "Adventure Department",
  lessons: [
    {
      id: "ad-gallery-recipe",
      title: "The mural is a recipe",
      teaser: "Scrub the draw order and watch the mural paint itself, one step at a time.",
      steps: [
        "Drag the draw-order slider back to the start: the canvas is empty.",
        "Drag it forward slowly. Each step is one drawing command: a line, or a fill of colour.",
        "Watch the sky: it pours in last, because a fill only floods white.",
        "Click Sun in the list. Every step in it lights up.",
      ],
      open: { studio: "room", picture: MURAL },
      challenge: {
        prompt: "Change the sun: a new colour, size or place. Leave everything else as it is.",
        verify: verifyMuralObject,
      },
    },
    {
      id: "ad-lab-mirror",
      title: "One robot, two directions",
      teaser: "The robot's left-facing loop is a mirror. Fix it, and only that facing changes.",
      steps: [
        "Loop 0 is the robot facing right: four drawings, or cels, that make his wave.",
        "Loop 1 faces left. It has no drawings of its own: it mirrors loop 0.",
        "Turn on Onion to see one cel over the next.",
        "Click a cel in the Loop 1 row first. Edit it: loop 1 becomes its own copy, and loop 0 stays as it was.",
      ],
      open: { studio: "sprite", view: ROBOT_VIEW, loop: 1, cel: 0 },
      challenge: {
        prompt: "Give the left-facing robot a different eye colour. Loop 0 stays as it is.",
        verify: verifyMirrorEdit,
      },
    },
    {
      id: "ad-archive-depth",
      title: "Depth decides who is in front",
      teaser: "Drag a ghost behind the counter and see why its 11 hides Felix at 10.",
      steps: [
        "Switch to the Depth lens. Every colour is a depth number, which AGI calls priority.",
        "Turn on the ghost and drag it behind the counter: the counter's 11 hides it. Lower on the screen means a bigger number, so in front it shows.",
        "Now drag it behind the ledger stand. It floats in front: the stand has no depth.",
        "Click Counter depth in the list, then its last step under Details › Steps. New shapes go from there, before the walk barriers.",
      ],
      open: { studio: "room", picture: ARCHIVE },
      challenge: {
        prompt:
          "Draw a filled rectangle of depth 11 over the ledger stand, so the ghost hides behind it too. Change depth only.",
        verify: verifyStandDepth,
      },
    },
  ],
};
