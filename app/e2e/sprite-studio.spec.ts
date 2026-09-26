import { readFile } from "node:fs/promises";
import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { readGameZip } from "../src/gameZip.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import {
  openSprite,
  samePixels,
  type SpriteCel,
  type SpriteDocument,
} from "../../src/studio/sprite/spriteDocument.ts";
import {
  configureAi,
  enterCreateMode,
  isolateStorage,
  openDeveloperActivity,
  openGameOptions,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Sprite Studio end to end. The real app runs the catalog tutorial, whose
 * apprentice (VIEW 0) walks right in loop 0 and left in loop 1, a mirror of
 * loop 0; the harness (sprite-harness.html) runs the same VIEW for the
 * editing semantics that need no game. Expected pixels come from decoding
 * the bytes read out of the page, storage and the exported ZIP with the
 * sprite kernel here; the edited cell is placed by hand.
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

async function storedFiles(page: Page, projectId: string): Promise<Map<string, Uint8Array>> {
  const files = await page.evaluate(async (id) => {
    const path = "/src/gameStorage.ts";
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
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await enterCreateMode(page);
}

async function openApprentice(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-sprite-0").click();
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

/** One presented frame with the screen-object table and ownership plane captured with it. */
interface EgoFrame {
  readonly visual: number[];
  /** Per pixel: the owning object's number + 1, 0 for the picture. */
  readonly ownership: number[];
  readonly ego: { view: number; loop: number; cel: number; x: number; y: number };
}

/**
 * The ego's own pixels in a frame (ownership 1: object 0), as "x,y=colour",
 * and the pixels `cel` paints standing at the ego's x and baseline y.
 */
function egoPixels(frame: EgoFrame): string[] {
  const out: string[] = [];
  frame.ownership.forEach((owner, i) => {
    if (owner === 1) out.push(`${i % 160},${Math.floor(i / 160)}=${frame.visual[i]}`);
  });
  return out.sort();
}
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

/**
 * Walk ego with an arrow (AGI latches it) and sample the frames the engine
 * presents. The Inspect tab arms the objects and ownership channels, so each
 * frame carries the screen-object table of the very cycle it shows: the ego's
 * loop and cel are read from the engine, never inferred from timing.
 */
async function walkAndSample(page: Page, key: "ArrowLeft" | "ArrowRight", samples = 40) {
  await page.getByTestId("input-line").focus();
  await page.keyboard.press(key);
  await waitForCycles(page, 4);
  const frames: EgoFrame[] = [];
  for (let i = 0; i < samples; i++) {
    const frame = await page.evaluate(() => {
      const latest = window.__AGI_FRAME__!()!;
      const ego = latest.objects?.find((object) => object.num === 0);
      return latest.ownership && ego
        ? {
            visual: [...latest.visual],
            ownership: [...latest.ownership],
            ego: { view: ego.view, loop: ego.loop, cel: ego.cel, x: ego.x, y: ego.y },
          }
        : null;
    });
    if (frame) frames.push(frame);
    await page.waitForTimeout(35);
  }
  return frames;
}

test("a mirrored actor is repaired without changing its source loop, kept, reloaded, exported and played", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await playTutorial(page);
  const catalog = new URL(page.url()).hash;

  // Opened and closed untouched: nothing forks, nothing is written.
  let studio = await openApprentice(page);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  expect(await draftBytes(page)).toEqual(TUTORIAL_VIEW_0);
  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe(catalog);
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"))).not.toMatch(
    /^remix-/,
  );

  studio = await openApprentice(page);
  await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveText(/mirror of 0/);
  const original = open(TUTORIAL_VIEW_0);
  const before = original.loops[1]!.cels[0]!;
  expect(at(before, CENTRE.x, CENTRE.y)).not.toBe(before.transparent);
  expect(at(before, CENTRE.x, CENTRE.y)).not.toBe(RED);

  // One pixel in loop 1: it becomes a separate copy, and loop 0 is as it was.
  await paintCentre(page, studio, 1);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
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

  // Keep: the catalog tutorial forks a remix on its first edit.
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  const remix = await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"));
  expect(remix).toMatch(/^remix-/);
  expect(await storedView(page, remix!)).toEqual(kept);
  await studio.getByTestId("studio-close").click();
  await expect(page).toHaveURL(new RegExp(`#create/${remix}$`));

  // Play: walking right shows loop 0's own cels, walking left the fix. The
  // Inspect tab arms the per-frame object table and ownership plane.
  await page.getByTestId("dock-tab-inspect").click();
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
    expect(egoPixels(frame)).toEqual(celPixels(frame, original.loops[0]!.cels[frame.ego.cel]!));
  for (const frame of left)
    expect(egoPixels(frame)).toEqual(celPixels(frame, edited.loops[1]!.cels[frame.ego.cel]!));
  // Walking left reaches cel 0, which shows the fix; walking right never does.
  const fixedFrames = left.filter((frame) => frame.ego.cel === 0);
  expect(fixedFrames.length).toBeGreaterThan(0);
  for (const frame of fixedFrames) expect(egoPixels(frame)).toEqual(celPixels(frame, fixed));
  expect(right.some((frame) => egoPixels(frame).join() === celPixels(frame, fixed).join())).toBe(
    false,
  );
  await page.keyboard.press("ArrowLeft");

  // A reload boots the stored remix: Studio opens on the kept bytes.
  await page.reload();
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  studio = await openApprentice(page);
  expect(await draftBytes(page)).toEqual(kept);
  await studio.getByTestId("studio-close").click();

  // The exported game's VIEW is the kept bytes.
  const downloading = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-export-game").click();
  const exported = await readGameZip(await readFile((await (await downloading).path())!));
  expect(openContainer(new Map(Object.entries(exported.files))).getResource("view", 0)).toEqual(
    kept,
  );
});

test("a loop's cyan recoloured to blue by keys is kept, and the walking ego shows it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await playTutorial(page);
  const studio = await openApprentice(page);
  const CYAN = 11;
  const BLUE = 1;
  const original = open(TUTORIAL_VIEW_0);
  expect(at(original.loops[0]!.cels[0]!, CENTRE.x, CENTRE.y)).toBe(CYAN);

  // At 1440×900 the panel shows the palette, the previews and the room without scrolling.
  const panel = studio.getByRole("complementary", { name: "Cel, previews and linked loops" });
  await expect(studio.getByTestId("sprite-mirror-note")).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  const roomBox = (await studio.getByTestId("sprite-room-verdict").boundingBox())!;
  expect(roomBox.y + roomBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height);
  expect(await panel.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);

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
  // Loop 0's cels hold 39, 33, 39 and 33 cyan pixels.
  await expect(recolor.getByTestId("sprite-recolor-count")).toHaveText(
    "144 pixels in 4 cels will change to colour 1, blue.",
  );
  await expect(recolor.getByTestId("sprite-recolor-copies")).toHaveText(
    "Loop 0 will become a separate copy; the loops linked to it keep their pixels.",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(recolor.getByTestId("sprite-recolor-apply")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  // The edit's notice shows while the popover is still open, recentred clear of it.
  const note = studio.locator(".stage-note");
  await expect(note).toBeVisible();
  const noteBox = await note.boundingBox();
  const popBox = await recolor.boundingBox();
  expect(noteBox).not.toBeNull();
  expect(popBox).not.toBeNull();
  expect(popBox!.x + popBox!.width).toBeLessThanOrEqual(noteBox!.x);
  await expect(recolor.getByTestId("sprite-recolor-count")).toHaveText(
    "No pixels of colour 11, light cyan in this loop.",
  );

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
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await studio.getByTestId("studio-close").click();

  // Walking right shows loop 0's blue cels exactly; walking left keeps the cyan.
  await page.getByTestId("dock-tab-inspect").click();
  const right = (await walkAndSample(page, "ArrowRight")).filter(
    (frame) => frame.ego.view === 0 && frame.ego.loop === 0,
  );
  expect(right.length).toBeGreaterThan(10);
  for (const frame of right) {
    const cel = recoloured.loops[0]!.cels[frame.ego.cel]!;
    expect(egoPixels(frame)).toEqual(celPixels(frame, cel));
    expect(egoPixels(frame).some((pixel) => pixel.endsWith(`=${BLUE}`))).toBe(true);
    expect(egoPixels(frame).some((pixel) => pixel.endsWith(`=${CYAN}`))).toBe(false);
  }
  const left = (await walkAndSample(page, "ArrowLeft", 20)).filter(
    (frame) => frame.ego.view === 0 && frame.ego.loop === 1,
  );
  expect(left.length).toBeGreaterThan(5);
  for (const frame of left)
    expect(egoPixels(frame)).toEqual(celPixels(frame, original.loops[1]!.cels[frame.ego.cel]!));
  await page.keyboard.press("ArrowLeft");
});

test("a Keep refuses as stale when the project changed elsewhere, and reopens from storage", async ({
  page,
}) => {
  await playTutorial(page);
  let studio = await openApprentice(page);
  await paintCentre(page, studio, 2);
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  const remix = (await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame")))!;

  // Another tab changes the stored remix while this draft has an edit.
  await paintCentre(page, studio, 3, 1);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const elsewhere = openContainer(await storedFiles(page, remix));
  elsewhere.putResource("view", 9, elsewhere.getResource("view", 0)!);
  const moved = await page.evaluate(
    async ([id, files]) => {
      const path = "/src/gameStorage.ts";
      const { updateAuthoredGameFiles } = await import(path);
      return updateAuthoredGameFiles(
        id,
        Object.fromEntries(files!.map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
      );
    },
    [remix, [...elsewhere.files].map(([name, bytes]) => [name, [...bytes]] as const)] as const,
  );
  expect(moved).toBe(true);
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-keep-error")).toContainText(
    "The game changed since you opened Studio. Reopen to continue.",
  );
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await studio.getByTestId("studio-recover").click();
  const dialog = page.getByRole("dialog", { name: "Reload the saved game?" });
  await expect(dialog).toContainText("Your unkept changes in this view will be discarded");
  await page.getByTestId("studio-dialog-reload").click();
  studio = page.getByTestId("sprite-studio");
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "Loaded the latest saved version of this game.",
  );
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  // Reopened on the stored project: the next Keep lands beside the other edit.
  await paintCentre(page, studio, 3, 1);
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  expect(await storedView(page, remix)).toEqual(await draftBytes(page));
});

test.describe("on the harness", () => {
  test("Edit loop 0 instead propagates to both facings; undo, redo and Keep", async ({ page }) => {
    await page.goto("/sprite-harness.html?view=0");
    const studio = page.getByTestId("sprite-studio");
    await studio.locator('[data-loop="1"][data-cel="0"]').click();
    await expect(studio.getByTestId("sprite-mirror-text")).toHaveText(
      "Loop 1 mirrors loop 0. Editing loop 1 makes it a separate copy; loop 0 stays as it is.",
    );
    await studio.getByTestId("sprite-propagate").click();
    await expect(studio.locator('[data-loop="0"][data-cel="0"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(studio.getByTestId("sprite-mirror-text")).toHaveText(
      "Editing loop 0 changes loop 1 with it: a mirrored loop shows the edit mirrored.",
    );
    await studio.locator(`[data-colour="${RED}"]`).click();
    await studio.getByTestId("sprite-stage").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    const both = open(await draftBytes(page));
    const width = both.loops[0]!.cels[0]!.width;
    expect(both.loops[1]!.alias).toBe(0);
    for (const cel of both.loops[0]!.cels.slice(0, 1))
      expect(at(cel, CENTRE.x, CENTRE.y)).toBe(RED);
    expect(at(both.loops[1]!.cels[0]!, width - 1 - CENTRE.x, CENTRE.y)).toBe(RED);
    await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveText(/mirror of 0/);

    // Undo, redo, and Keep hands the harness exactly the draft's bytes.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
    expect(await draftBytes(page)).toEqual(TUTORIAL_VIEW_0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    const redone = await draftBytes(page);
    await studio.getByTestId("studio-keep").click();
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
    const kept = await page.evaluate(() =>
      (
        window as unknown as { spriteHarness: { kept: { edit: { bytes: Uint8Array } }[] } }
      ).spriteHarness.kept.map(({ edit }) => [...edit.bytes]),
    );
    expect(kept).toEqual([[...redone]]);
  });

  test("the contact sheet shows every cel, is chosen from by keys, and returns to the editor", async ({
    page,
  }) => {
    await page.goto("/sprite-harness.html?view=0");
    const studio = page.getByTestId("sprite-studio");
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
    await expect(studio.getByTestId("sprite-cel-summary")).toContainText("Cel 1 of loop 2");
    await expect(studio.getByTestId("sprite-stage")).toBeFocused();
    // Esc closes the sheet, not Studio.
    await studio.getByTestId("sprite-sheet-toggle").click();
    await expect(sheet.locator('[aria-current="true"]')).toHaveAttribute("data-loop", "2");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(studio).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { spriteHarness: { closes: number } }).spriteHarness.closes,
      ),
    ).toBe(0);
  });

  test("Esc in the width field reverts it and leaves the field; Studio stays open", async ({
    page,
  }) => {
    await page.goto("/sprite-harness.html?view=0");
    const studio = page.getByTestId("sprite-studio");
    const closes = () =>
      page.evaluate(
        () => (window as unknown as { spriteHarness: { closes: number } }).spriteHarness.closes,
      );
    await studio.getByTestId("sprite-cel-summary").click();
    await studio.getByText("Resize", { exact: true }).click();
    const width = studio.getByRole("spinbutton", { name: "Width in pixels" });
    await expect(studio.getByRole("spinbutton", { name: "Height in pixels" })).toHaveValue("32");
    await width.fill("6");
    await page.keyboard.press("Escape");
    await expect(studio).toBeVisible();
    await expect(width).toHaveValue("10");
    await expect(width).not.toBeFocused();
    expect(await closes()).toBe(0);
    // Off the field, Esc leaves Studio.
    await page.keyboard.press("Escape");
    await expect.poll(closes).toBe(1);
  });

  test("a cel is copied and moved to another loop from its menu by keys", async ({ page }) => {
    await page.goto("/sprite-harness.html?view=0");
    const studio = page.getByTestId("sprite-studio");
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
    await expect(menu.getByRole("menuitem", { name: "Loop 0 · Right-facing" })).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Loop 3 · Back-facing" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    const copied = open(await draftBytes(page));
    expect(copied.loops.map((loop) => loop.cels.length)).toEqual([4, 4, 4, 5]);
    expect(samePixels(copied.loops[3]!.cels[4]!.pixels, original.loops[2]!.cels[1]!.pixels)).toBe(
      true,
    );
    expect(copied.loops[1]!.alias).toBe(0);
    // The copy is selected; Move to loop… takes it back to loop 2 as one undo step.
    const copy = studio.locator('.timeline [data-loop="3"][data-cel="4"]');
    await expect(copy).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await menu.getByRole("menuitem", { name: "Move to loop…" }).focus();
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitem", { name: /^Loop 3/ })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Loop 2 · Front-facing" }).focus();
    await page.keyboard.press("Enter");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("2 changes");
    const moved = open(await draftBytes(page));
    expect(moved.loops.map((loop) => loop.cels.length)).toEqual([4, 4, 5, 4]);
    expect(samePixels(moved.loops[2]!.cels[4]!.pixels, original.loops[2]!.cels[1]!.pixels)).toBe(
      true,
    );
    await expect(studio.locator('.timeline [data-loop="2"][data-cel="4"]')).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    expect(open(await draftBytes(page)).loops.map((loop) => loop.cels.length)).toEqual([
      4, 4, 4, 5,
    ]);
  });

  test("a held pen shows its cue on the stage and on the disabled Keep", async ({ page }) => {
    await page.goto("/sprite-harness.html?view=0");
    const studio = page.getByTestId("sprite-studio");
    const keep = studio.getByTestId("studio-keep");
    const cue = studio.getByTestId("sprite-pen-down");
    await studio.locator(`[data-colour="${RED}"]`).click();
    await studio.getByTestId("sprite-stage").focus();
    await expect(cue).toHaveCount(0);
    // The first Space puts the pen down: the cue is on the stage and in the
    // live region, and the disabled Keep says why. The next Space lifts it.
    await page.keyboard.press("Space");
    await expect(cue).toHaveText("Pen down — Space to lift");
    await expect(studio.locator(".sprite-studio__sr")).toContainText("Pen down — Space to lift");
    await expect(keep).toBeDisabled();
    await expect(keep).toHaveAttribute("title", /pen is down/i);
    await page.keyboard.press("Space");
    await expect(cue).toHaveCount(0);
    await expect(keep).not.toHaveAttribute("title", /pen/i);
    await expect(keep).toBeEnabled();
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  });

  test("keyboard only: a line drawn with the cursor and kept", async ({ page }) => {
    await page.goto("/sprite-harness.html?view=0");
    const studio = page.getByTestId("sprite-studio");
    await studio.getByTestId("sprite-stage").focus();
    await page.keyboard.press("l");
    // From the centre (5,16), 3 left and 12 up (Shift: 8): 2,4; then 4 right: a line to 6,4.
    for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "Shift+ArrowUp", "ArrowUp"])
      await page.keyboard.press(key);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Space");
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
    const drawn = open(await draftBytes(page)).loops[0]!.cels[0]!;
    const before = open(TUTORIAL_VIEW_0).loops[0]!.cels[0]!;
    expect([2, 3, 4, 5, 6].some((x) => at(before, x, 4) !== 11)).toBe(true);
    expect([2, 3, 4, 5, 6].map((x) => at(drawn, x, 4))).toEqual([11, 11, 11, 11, 11]);
    // Keys never reached anything outside: the harness saw no close.
    await studio.getByTestId("studio-keep").focus();
    await page.keyboard.press("Enter");
    await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
    expect(
      await page.evaluate(
        () => (window as unknown as { spriteHarness: { closes: number } }).spriteHarness.closes,
      ),
    ).toBe(0);
  });
});

/** An opaque magenta key field with one cyan figure per 16px pose cell. */
function sheetPng(): Buffer {
  const width = 64;
  const height = 12;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const lx = x % 16;
      const figure = lx >= 5 && lx < 11 && y >= 2;
      rgb.set(figure ? [0, 0xff, 0xff] : [0xff, 0, 0xff], (y * width + x) * 3);
    }
  return Buffer.from(encodePngRgb(width, height, rgb));
}

test("a staged character-sheet candidate opens in Sprite Studio, is repaired and kept", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await isolateStorage(page);
  await page.route("**/api/openai/v1/responses", (route) =>
    route.fulfill(providerReply("openai", { id: "reply", output: [] })),
  );
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await enterCreateMode(page);
  await page.getByTestId("power-up").click();
  await page.getByTestId("agent-attach-reference").click();
  await page.getByTestId("reference-kind-character").click();
  await page.getByTestId("reference-facing-right").setInputFiles({
    name: "hero-right.png",
    mimeType: "image/png",
    buffer: sheetPng(),
  });
  await page.getByTestId("reference-attach").click();
  await expect(page.getByTestId("reference-preview")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("reference-open-sprite").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("reference-upload")).toBeHidden();
  const candidate = await draftBytes(page);
  const staged = open(candidate);
  // The candidate's cel 0 of loop 0 gets a red pixel on its figure.
  const cel = staged.loops[0]!.cels[0]!;
  const point = { x: Math.floor(cel.width / 2), y: Math.floor(cel.height / 2) };
  expect(at(cel, point.x, point.y)).not.toBe(cel.transparent);
  await studio.locator(`[data-colour="${RED}"]`).click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const repaired = await draftBytes(page);
  expect(at(open(repaired).loops[0]!.cels[0]!, point.x, point.y)).toBe(RED);
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");

  const stored = await page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGame } = await import("/src/gameStorage.ts");
    const id = listCachedGames()[0]!.projectId;
    const data = await loadAuthoredGame(id);
    return { id, staged: data?.references?.find((r) => r.kind === "character")?.staged ?? null };
  });
  expect(stored.staged).toBe(null);
  expect(await storedView(page, stored.id)).toEqual(repaired);
});
