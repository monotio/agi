import type { Locator, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import {
  openSprite,
  samePixels,
  type SpriteCel,
  type SpriteDocument,
} from "../../src/view/spriteDocument.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import {
  closeWorkspaceEditor,
  enterCreateMode,
  openGameOptions,
  openInspector,
  openWorkspaceView,
  waitForRoom,
  workspaceSaved,
  workspaceUpdated,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * Sprite Studio end to end. The real app runs the catalog tutorial, whose
 * apprentice (VIEW 0) walks right in loop 0 and left in loop 1, a mirror of
 * loop 0; the workspace VIEW editor runs the same VIEW for editing semantics.
 * Expected pixels come from decoding the bytes read out of the page, storage
 * and the exported ZIP with the sprite kernel here; the edited cell is placed by hand.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const TUTORIAL_VIEW_0 = openContainer(new Map(Object.entries(buildTutorial().files))).getResource(
  "view",
  0,
)!;
const open = (bytes: Uint8Array): SpriteDocument => openSprite(bytes, DEFAULT_V2_PROFILE);
const at = (cel: SpriteCel, x: number, y: number): number => cel.pixels[y * cel.width + x]!;
/** Where the pencil lands: the keyboard cursor starts at the cel's centre. */
const CENTRE = { x: 5, y: 16 };
const RED = 4;

const draftBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]));

async function sessionViewBytes(page: Page, viewNumber = 0): Promise<Uint8Array | null> {
  const result = await page.evaluate((num) => {
    const probe = window as unknown as {
      __AGI_PROJECT__?: {
        getSession(): {
          workingSnapshot(): {
            read(key: string): { content: unknown } | undefined;
          };
          model: {
            capture(): {
              lastAdmissibleBuild?: {
                files(): ReadonlyMap<string, Uint8Array>;
              };
            };
          };
        };
      };
    };
    const session = probe.__AGI_PROJECT__?.getSession();
    if (!session) return null;
    const document = session.workingSnapshot().read(`view:${num}`);
    if (document?.content instanceof Uint8Array) {
      return { kind: "content" as const, bytes: Array.from(document.content) };
    }
    const buildFiles = session.model.capture().lastAdmissibleBuild?.files();
    if (buildFiles) {
      const entries = Array.from(buildFiles.entries()).map(([k, v]) => [k, Array.from(v)] as const);
      return { kind: "files" as const, entries };
    }
    return null;
  }, viewNumber);

  if (!result) return null;
  if (result.kind === "content") return Uint8Array.from(result.bytes);
  const container = openContainer(new Map(result.entries.map(([k, v]) => [k, Uint8Array.from(v)])));
  return container.getResource("view", viewNumber);
}

async function storedFiles(page: Page, projectId: string): Promise<Map<string, Uint8Array>> {
  const files = await page.evaluate(async (id) => {
    const path = "/src/project/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    const game = await loadAuthoredGame(id);
    return Object.fromEntries(
      Object.entries(game.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        [...bytes],
      ]),
    );
  }, projectId);
  return new Map(Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
}

async function storedView(page: Page, projectId: string): Promise<Uint8Array> {
  return openContainer(await storedFiles(page, projectId)).getResource("view", 0)!;
}

/** Play the catalog tutorial into room 1, in Create. */
async function playTutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

async function openApprentice(page: Page): Promise<Locator> {
  await openWorkspaceView(page, 0);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** Pick the paint colour, select a cel on the timeline and paint the cursor's first cell by keys. */
async function paintCentre(page: Page, studio: Locator, loop: number, colour = RED) {
  await studio.locator(`[data-colour="${colour}"]`).click();
  await studio.locator(`[data-loop="${loop}"][data-cel="0"]`).click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("b");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
}

/** One presented frame's ego: its own pixels and the screen-object record captured with them. */
interface EgoFrame {
  /** The pixels object 0 owns (ownership 1), as "x,y=colour". */
  readonly pixels: string[];
  readonly room: number;
  readonly cycle: number;
  readonly ego: {
    view: number;
    loop: number;
    cel: number;
    x: number;
    y: number;
    direction: number;
  };
}

/**
 * The latest presented frame's ego, or null before the Inspect tab armed the
 * objects and ownership channels. Only the ego's pixels leave the page, so a
 * sample costs little on a loaded machine.
 */
function egoFrame(page: Page): Promise<EgoFrame | null> {
  return page.evaluate(() => {
    const latest = window.__AGI_FRAME__?.();
    const ego = latest?.objects?.find((object) => object.num === 0);
    const room = window.__AGI_TEXT__?.room;
    if (!latest?.ownership || !ego || room === undefined) return null;
    const pixels: string[] = [];
    latest.ownership.forEach((owner, i) => {
      if (owner === 1) pixels.push(`${i % 160},${Math.floor(i / 160)}=${latest.visual[i]}`);
    });
    return {
      pixels: pixels.sort(),
      room,
      cycle: window.__AGI_TEXT__!.cycle,
      ego: {
        view: ego.view,
        loop: ego.loop,
        cel: ego.cel,
        x: ego.x,
        y: ego.y,
        direction: ego.direction,
      },
    };
  });
}

/** The pixels `cel` paints standing at the frame's ego x and baseline y. */
function celPixels(frame: EgoFrame, cel: SpriteCel): string[] {
  const out: string[] = [];
  const top = frame.ego.y - cel.height + 1;
  for (let cy = 0; cy < cel.height; cy++)
    for (let cx = 0; cx < cel.width; cx++) {
      const value = at(cel, cx, cy);
      if (value !== cel.transparent) out.push(`${frame.ego.x + cx},${top + cy}=${value}`);
    }
  return out.sort();
}

/** The AGI directions the arrows set. */
const DIRECTION = { ArrowRight: 3, ArrowLeft: 7 } as const;
/**
 * Room 1's east edge runs new.room(2), which stops the ego at the next room's
 * door; the right walk turns back well short of it.
 */
const TURN_BACK_X = 100;

/**
 * Walk ego with an arrow (AGI latches it) and sample the frames the engine
 * presents while it walks that way in room 1, then stop it with the same
 * arrow. The Inspect tab arms the objects and ownership channels, so each
 * frame carries the screen-object table of the very cycle it shows: the
 * ego's loop and cel are read from the engine, never inferred from timing.
 * The walk is bounded by where the ego is, not by how long sampling takes: a
 * loaded page samples slowly, and a walk timed in samples once crossed into
 * room 2 and left again by its west door, so the "left" frames showed an ego
 * standing in another room.
 */
async function walkAndSample(page: Page, key: "ArrowLeft" | "ArrowRight", samples = 40) {
  const direction = DIRECTION[key];
  await page.getByTestId("input-line").focus();
  await page.keyboard.press(key);
  await expect.poll(async () => (await egoFrame(page))?.ego.direction).toBe(direction);
  const frames: EgoFrame[] = [];
  while (frames.length < samples) {
    const frame = await egoFrame(page);
    if (
      !frame ||
      frame.room !== 1 ||
      frame.ego.direction !== direction ||
      // Only a walk east can reach the east exit; a walk west may begin past
      // the turn-back point when the eastward walk overshot it on a slow host.
      (key === "ArrowRight" && frame.ego.x > TURN_BACK_X)
    )
      break;
    frames.push(frame);
    await expect.poll(async () => (await egoFrame(page))?.cycle).toBeGreaterThan(frame.cycle);
  }
  // The same arrow stops the walk; the west wall may already have.
  if ((await egoFrame(page))?.ego.direction === direction) await page.keyboard.press(key);
  await expect.poll(async () => (await egoFrame(page))?.ego.direction).toBe(0);
  return frames;
}

test("a mirrored actor is repaired without changing its source loop, saved, reloaded, exported and played @webkit-desktop", async ({
  page,
}) => {
  await playTutorial(page);
  const catalog = new URL(page.url()).hash;

  // Opened and closed untouched: nothing forks, nothing is written.
  let studio = await openApprentice(page);
  await workspaceSaved(page);
  expect(await draftBytes(page)).toEqual(TUTORIAL_VIEW_0);
  await closeWorkspaceEditor(page);
  await expect(studio).toBeHidden();
  expect(new URL(page.url()).hash).toBe(catalog);
  expect(
    await page.evaluate(() => localStorage.getItem("monotio_agi.resumeTarget")?.split(":")[1]),
  ).not.toMatch(/^remix-/);

  studio = await openApprentice(page);
  await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveText(/mirrors 0/);
  const original = open(TUTORIAL_VIEW_0);
  const before = original.loops[1]!.cels[0]!;
  expect(at(before, CENTRE.x, CENTRE.y)).not.toBe(before.transparent);
  expect(at(before, CENTRE.x, CENTRE.y)).not.toBe(RED);

  // One pixel in loop 1: it becomes a separate copy, and loop 0 is as it was.
  await paintCentre(page, studio, 1);
  await workspaceSaved(page);
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "Loop 1 is now a separate copy; the loop it mirrored kept its pixels.",
  );
  await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveCount(0);
  const kept = await draftBytes(page);
  const edited = open(kept);
  expect(edited.loops[1]!.alias).toBe(null);
  const fixed = edited.loops[1]!.cels[0]!;
  expect(at(fixed, CENTRE.x, CENTRE.y)).toBe(RED);
  const changed = [...fixed.pixels].filter((value, i) => value !== before.pixels[i]).length;
  expect(changed).toBe(1);
  for (const loop of [0, 2, 3])
    edited.loops[loop]!.cels.forEach((cel, index) =>
      expect(samePixels(cel.pixels, original.loops[loop]!.cels[index]!.pixels)).toBe(true),
    );
  edited.loops[1]!.cels.slice(1).forEach((cel, index) =>
    expect(samePixels(cel.pixels, original.loops[1]!.cels[index + 1]!.pixels)).toBe(true),
  );

  // Update game forks a remix on the first catalog update.
  await workspaceUpdated(page);
  const remix = await page.evaluate(
    () => localStorage.getItem("monotio_agi.resumeTarget")?.split(":")[1],
  );
  expect(remix).toMatch(/^remix-/);
  expect(await storedView(page, remix!)).toEqual(kept);
  await closeWorkspaceEditor(page);
  await expect(page).toHaveURL(new RegExp(`#create/${remix}$`));

  // Play: walking right shows loop 0's own cels, walking left the fix. The
  // Inspect tab arms the per-frame object table and ownership plane.
  await openInspector(page);
  const right = (await walkAndSample(page, "ArrowRight")).filter(
    (frame) => frame.ego.view === 0 && frame.ego.loop === 0,
  );
  const left = (await walkAndSample(page, "ArrowLeft")).filter(
    (frame) => frame.ego.view === 0 && frame.ego.loop === 1,
  );
  expect(right.length).toBeGreaterThan(10);
  expect(left.length).toBeGreaterThan(10);
  // Every frame shows exactly the cel the engine says the ego is on.
  for (const frame of right)
    expect(frame.pixels).toEqual(celPixels(frame, original.loops[0]!.cels[frame.ego.cel]!));
  for (const frame of left)
    expect(frame.pixels).toEqual(celPixels(frame, edited.loops[1]!.cels[frame.ego.cel]!));
  // Walking left reaches cel 0, which shows the fix; walking right never does.
  const fixedFrames = left.filter((frame) => frame.ego.cel === 0);
  expect(fixedFrames.length).toBeGreaterThan(0);
  for (const frame of fixedFrames) expect(frame.pixels).toEqual(celPixels(frame, fixed));
  expect(right.some((frame) => frame.pixels.join() === celPixels(frame, fixed).join())).toBe(false);

  // A reload boots the stored remix: Studio opens on the kept bytes.
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await waitForRoom(page, 1);
  await openApprentice(page);
  expect(await draftBytes(page)).toEqual(kept);
  await closeWorkspaceEditor(page);

  // The exported game's VIEW is the kept bytes.
  const downloading = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-export-game").click();
  const exported = await readGameZip(await readFile((await (await downloading).path())!));
  expect(openContainer(new Map(Object.entries(exported.files))).getResource("view", 0)).toEqual(
    kept,
  );
});

test("a loop's cyan recoloured to blue by keys is saved, and the walking ego shows it", async ({
  page,
}) => {
  await playTutorial(page);
  const studio = await openApprentice(page);
  const CYAN = 3;
  const BLUE = 1;
  const original = open(TUTORIAL_VIEW_0);
  expect(at(original.loops[0]!.cels[0]!, CENTRE.x, CENTRE.y)).toBe(CYAN);

  // C, then Space on the canvas picks the cyan under the cursor as the colour to change.
  await studio.locator('[data-loop="0"][data-cel="0"]').click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("c");
  const recolor = studio.getByTestId("sprite-recolor");
  await expect(recolor).toBeVisible();
  await page.keyboard.press("Space");
  await expect(
    recolor.getByTestId("sprite-recolor-from").getByRole("radio", { checked: true }),
  ).toHaveAttribute("data-colour", String(CYAN));
  // Tab past Close and From to To; the arrow picks blue; the scope stays "This loop".
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowRight");
  await expect(recolor.getByRole("radio", { name: "This loop" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const count = original.loops[0]!.cels.reduce(
    (total, cel) => total + [...cel.pixels].filter((pixel) => pixel === CYAN).length,
    0,
  );
  await expect(recolor.getByTestId("sprite-recolor-count")).toHaveText(
    `${count} pixels in 4 cels will change to colour 1, blue.`,
  );
  await expect(recolor.getByTestId("sprite-recolor-copies")).toHaveText(
    "Loop 0 will become a separate copy; the loops linked to it keep their pixels.",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(recolor.getByTestId("sprite-recolor-apply")).toBeFocused();
  await page.keyboard.press("Enter");
  await workspaceSaved(page);
  // The edit's notice shows in the status line while the popover is still open.
  await expect(studio.locator(".sprite-studio__status").getByTestId("studio-notice")).toBeVisible();
  await expect(recolor.getByTestId("sprite-recolor-count")).toHaveText(
    "colour 3, cyan is unused in this loop. Choose a colour used here.",
  );
  // The spent Recolour button leaves focus in the popover, on the From colour,
  // so the keys go on from there: Esc closes it.
  await expect(
    recolor.getByTestId("sprite-recolor-from").getByRole("radio", { checked: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recolor).toHaveCount(0);

  // Loop 0 is blue where it was cyan, and nothing else; loop 1 keeps its cyan as a separate copy.
  const recoloured = open(await draftBytes(page));
  expect(recoloured.loops[1]!.alias).toBe(null);
  recoloured.loops.forEach((entry, loop) =>
    entry.cels.forEach((cel, index) => {
      const before = original.loops[loop]!.cels[index]!;
      const expected = before.pixels.map((value) => (loop === 0 && value === CYAN ? BLUE : value));
      expect(samePixels(cel.pixels, expected)).toBe(true);
    }),
  );
  await workspaceUpdated(page);
  await closeWorkspaceEditor(page);

  // Walking right shows loop 0's blue cels exactly; walking left keeps the cyan.
  await openInspector(page);
  const right = (await walkAndSample(page, "ArrowRight")).filter(
    (frame) => frame.ego.view === 0 && frame.ego.loop === 0,
  );
  expect(right.length).toBeGreaterThan(10);
  for (const frame of right) {
    const cel = recoloured.loops[0]!.cels[frame.ego.cel]!;
    expect(frame.pixels).toEqual(celPixels(frame, cel));
    expect(frame.pixels.some((pixel) => pixel.endsWith(`=${BLUE}`))).toBe(true);
    expect(frame.pixels.some((pixel) => pixel.endsWith(`=${CYAN}`))).toBe(false);
  }
  const left = (await walkAndSample(page, "ArrowLeft", 20)).filter(
    (frame) => frame.ego.view === 0 && frame.ego.loop === 1,
  );
  expect(left.length).toBeGreaterThan(5);
  for (const frame of left)
    expect(frame.pixels).toEqual(celPixels(frame, original.loops[1]!.cels[frame.ego.cel]!));
});

test.describe("workspace VIEW editor", () => {
  test("Edit both on the mirror loop changes both facings; undo and redo", async ({ page }) => {
    await playTutorial(page);
    const studio = await openApprentice(page);
    await studio.locator('[data-loop="1"][data-cel="0"]').click();
    await expect(studio.getByTestId("sprite-mirror-text")).toHaveText("Mirrors loop 0");
    await studio.getByTestId("sprite-propagate").click();
    // Edit both stays on the loop in hand: the pair changes from here.
    await expect(studio.locator('[data-loop="1"][data-cel="0"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(studio.getByTestId("sprite-mirror-text")).toHaveText("Edits change loop 0 too");
    await expect(studio.getByTestId("sprite-propagate")).toHaveText("Edit one");
    await studio.locator(`[data-colour="${RED}"]`).click();
    await studio.getByTestId("sprite-stage").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("workspace-pending")).toHaveText("1 change not in the game yet");
    const both = open(await draftBytes(page));
    const width = both.loops[0]!.cels[0]!.width;
    expect(both.loops[1]!.alias).toBe(0);
    // Loop 1 shows the pixel where the cursor stood; loop 0, its source, shows it flipped.
    expect(at(both.loops[1]!.cels[0]!, CENTRE.x, CENTRE.y)).toBe(RED);
    expect(at(both.loops[0]!.cels[0]!, width - 1 - CENTRE.x, CENTRE.y)).toBe(RED);
    await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveText(/mirrors 0/);
    expect(await sessionViewBytes(page, 0)).toEqual(await draftBytes(page));

    // Update game commits the change: then Undo and Redo step through it.
    await workspaceUpdated(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => sessionViewBytes(page, 0)).toEqual(TUTORIAL_VIEW_0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.getByTestId("workspace-undo")).toBeEnabled();
    const redone = await sessionViewBytes(page, 0);
    expect(redone).toEqual(await draftBytes(page));
  });

  test("the contact sheet shows every cel, is chosen from by keys, and returns to the editor", async ({
    page,
  }) => {
    await playTutorial(page);
    const studio = await openApprentice(page);
    await studio.getByTestId("sprite-sheet-toggle").click();
    const sheet = studio.getByTestId("sprite-contact-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Loop \d+, cel \d+/ })).toHaveCount(16);
    const current = sheet.locator('[aria-current="true"]');
    await expect(current).toHaveAttribute("data-loop", "0");
    await expect(current).toHaveAttribute("data-cel", "0");
    await expect(current).toBeFocused();
    await expect(sheet.getByTestId("sprite-sheet-linked-1")).toHaveText(
      "mirror of 0 · shown flipped",
    );
    await expect(sheet.getByTestId("sprite-sheet-linked-0")).toHaveText("linked to 1");
    // Down twice to loop 2, right to its cel 1, Enter: the editor, on that cel.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await expect(sheet.locator('[data-loop="2"][data-cel="1"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveCount(0);
    await expect(studio.locator('.timeline [data-loop="2"][data-cel="1"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(studio.getByTestId("sprite-cel-summary")).toHaveText("Cel 1 · Loop 2");
    await expect(studio.getByTestId("sprite-stage")).toBeFocused();
    // Esc closes the sheet, not Studio.
    await studio.getByTestId("sprite-sheet-toggle").click();
    await expect(sheet.locator('[aria-current="true"]')).toHaveAttribute("data-loop", "2");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(studio).toBeVisible();
    // The view bar stays above the sheet: its toggle, pressed, closes it again.
    const toggle = studio.getByTestId("sprite-sheet-toggle");
    await toggle.click();
    await expect(sheet).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(sheet).toHaveCount(0);
    await expect(studio).toBeVisible();
  });

  test("Esc in the width field reverts it and leaves the field; Studio stays open", async ({
    page,
  }) => {
    await playTutorial(page);
    const studio = await openApprentice(page);
    await studio.getByTestId("sprite-cel-details").click();
    const width = studio.getByRole("spinbutton", { name: "Width in pixels" });
    await expect(studio.getByRole("spinbutton", { name: "Height in pixels" })).toHaveValue("32");
    await width.fill("6");
    await page.keyboard.press("Escape");
    await expect(studio).toBeVisible();
    await expect(width).toHaveValue("10");
    await expect(width).not.toBeFocused();
    // Off the field, with nothing in hand, Esc does nothing: closing the editor closes Studio.
    await page.keyboard.press("Escape");
    await expect(studio).toBeVisible();
    await closeWorkspaceEditor(page);
    await expect(studio).toBeHidden();
  });

  test("a cel is copied and moved to another loop from its menu by keys", async ({ page }) => {
    await playTutorial(page);
    const studio = await openApprentice(page);
    const original = open(TUTORIAL_VIEW_0);
    const cel = studio.locator('.timeline [data-loop="2"][data-cel="1"]');
    await cel.click();
    await cel.focus();
    await page.keyboard.press("Shift+F10");
    const menu = studio.getByTestId("sprite-context-menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Copy to loop…" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveAccessibleName("Copy loop 2, cel 1 to loop");
    await expect(menu.getByRole("menuitem", { name: "Loop 0 · Right" })).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Loop 3 · Back" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("workspace-pending")).toHaveText("1 change not in the game yet");
    const copiedBytes = (await sessionViewBytes(page, 0))!;
    const copied = open(copiedBytes);
    expect(copied.loops.map((loop) => loop.cels.length)).toEqual([4, 4, 4, 5]);
    expect(samePixels(copied.loops[3]!.cels[4]!.pixels, original.loops[2]!.cels[1]!.pixels)).toBe(
      true,
    );
    expect(copied.loops[1]!.alias).toBe(0);
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect(page.getByTestId("workspace-updated")).toBeVisible();
    await workspaceSaved(page);
    // The copy is selected; Move to loop… takes it back to loop 2 as one undo step.
    const copy = studio.locator('.timeline [data-loop="3"][data-cel="4"]');
    await expect(copy).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await menu.getByRole("menuitem", { name: "Move to loop…" }).focus();
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitem", { name: /^Loop 3/ })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Loop 2 · Front" }).focus();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("workspace-pending")).toHaveText("1 change not in the game yet");
    const movedBytes = (await sessionViewBytes(page, 0))!;
    const moved = open(movedBytes);
    expect(moved.loops.map((loop) => loop.cels.length)).toEqual([4, 4, 5, 4]);
    expect(samePixels(moved.loops[2]!.cels[4]!.pixels, original.loops[2]!.cels[1]!.pixels)).toBe(
      true,
    );
    await expect(studio.locator('.timeline [data-loop="2"][data-cel="4"]')).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect(page.getByTestId("workspace-updated")).toBeVisible();
    await workspaceSaved(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () =>
        open((await sessionViewBytes(page, 0))!).loops.map((loop) => loop.cels.length),
      )
      .toEqual([4, 4, 4, 5]);
    expect(open(await draftBytes(page)).loops.map((loop) => loop.cels.length)).toEqual([
      4, 4, 4, 5,
    ]);
  });

  test("a held pen shows its cue on the stage", async ({ page }) => {
    await playTutorial(page);
    const studio = await openApprentice(page);
    const cue = studio.getByTestId("sprite-pen-down");
    await studio.locator(`[data-colour="${RED}"]`).click();
    await studio.getByTestId("sprite-stage").focus();
    await expect(cue).toHaveCount(0);
    // The first Space puts the pen down: the cue is on the stage and in the
    // live region. The next Space lifts it.
    await page.keyboard.press("Space");
    await expect(cue).toHaveText("Pen down: Space lifts it");
    await expect(studio.locator(".sprite-studio__sr")).toContainText("Pen down: Space lifts it");
    await page.keyboard.press("Space");
    await expect(cue).toHaveCount(0);
    await expect(page.getByTestId("workspace-pending")).toHaveText("1 change not in the game yet");
    const editedBytes = (await sessionViewBytes(page, 0))!;
    expect(at(open(editedBytes).loops[0]!.cels[0]!, CENTRE.x, CENTRE.y)).toBe(RED);
  });

  test("keyboard only: a line drawn with the cursor", async ({ page }) => {
    await playTutorial(page);
    const studio = await openApprentice(page);
    await studio.getByTestId("sprite-stage").focus();
    await page.keyboard.press("l");
    // From the centre (5,16), 3 left and 12 up (Shift: 8): 2,4; then 4 right: a line to 6,4.
    for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "Shift+ArrowUp", "ArrowUp"])
      await page.keyboard.press(key);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Space");
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workspace-pending")).toHaveText("1 change not in the game yet");
    const drawn = open((await sessionViewBytes(page, 0))!).loops[0]!.cels[0]!;
    const before = open(TUTORIAL_VIEW_0).loops[0]!.cels[0]!;
    expect([2, 3, 4, 5, 6].some((x) => at(before, x, 4) !== 11)).toBe(true);
    expect([2, 3, 4, 5, 6].map((x) => at(drawn, x, 4))).toEqual([11, 11, 11, 11, 11]);
    await expect(studio).toBeVisible();
  });
});
