import type { Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { openContainer } from "../../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";

/**
 * The stored project's visual editors, end to end on the real app with no
 * key, no engine and no provider: Logic Studio's explorer opens PIC 1 in the
 * existing Room Studio and VIEW 0 in the existing Sprite Studio; their Keeps
 * land in the same EditableProject, so stored bytes, the draft and a cold
 * reopen all agree. Expected pixels are decoded here with the engine's own
 * renderer and sprite kernel from bytes read out of the page and storage;
 * the edits are placed by keyboard, not screenshot.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const DOCUMENT_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "starter",
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ title, kind }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title, kind });
      await prepared.save();
      return prepared.projectId as string;
    },
    { title, kind },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

async function storedFiles(page: Page, projectId: string): Promise<Map<string, Uint8Array>> {
  const files = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const game = await loadAuthoredGame(id as never);
    return Object.fromEntries(
      Object.entries(game!.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        [...bytes],
      ]),
    );
  }, projectId);
  return new Map(Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
}

/** The stored project's provable text for one document key — null for byte documents. */
async function storedDocument(page: Page, projectId: string, key: string) {
  return page.evaluate(
    async ({ projectId, key }) => {
      const storage = await import("/src/project/gameStorage.ts");
      const { inspectEditableProject } = await import("/src/project/projectWorkspaceSource.ts");
      const data = await storage.loadAuthoredGame(projectId as never);
      if (!data) return null;
      const document = inspectEditableProject(data).documents[key];
      return typeof document === "string" ? document : null;
    },
    { projectId, key },
  );
}

const visual = (bytes: Uint8Array): Uint8Array => {
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile: DEFAULT_V2_PROFILE });
  return Uint8Array.from(surface.visual);
};
const at = (plane: Uint8Array, x: number, y: number): number => plane[y * 160 + x]!;

/** The library's Edit verb: Logic Studio on the stored project, no engine. */
async function openLogicStudio(page: Page, title: string) {
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const studio = page.getByTestId("logic-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  return studio;
}

test("a starter PIC draws in Room Studio through Logic Studio, keeps and reopens cold @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Drawn clearing");
  await page.reload();

  const studio = await openLogicStudio(page, "Drawn clearing");
  const explorer = page.getByTestId("logic-explorer");

  // The picture document opens as text; the launch action names the editor.
  await explorer.getByTestId("logic-doc-picture:1").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText("Meadow");
  const launch = page.getByTestId("logic-resource-edit");
  await expect(launch).toHaveText("Edit picture");

  // Room Studio opens on the draft's bytes — the starter clearing.
  await launch.click();
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();
  await expect(room.getByTestId("studio-draft-status")).toHaveText("No changes");
  const before = Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
  const beforeSource = await page.evaluate(() => window.__AGI_STUDIO__!.source());
  await reviewShot(page, "project-resource-room-open");

  // A keyboard nudge of the first item: the sun moves one row down.
  await room.locator("[data-row]").first().click();
  await room.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(room.getByTestId("studio-draft-status")).toHaveText("1 change");
  const drawnSource = await page.evaluate(() => window.__AGI_STUDIO__!.source());
  expect(drawnSource).not.toBe(beforeSource);
  const drawn = Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
  expect(drawn).toEqual(compilePictureSource(drawnSource, { profile: DEFAULT_V2_PROFILE }).bytes);
  // The sun's old top row becomes sky.
  const [oldPlane, newPlane] = [visual(before), visual(drawn)];
  expect(at(oldPlane, 147, 3)).toBe(14);
  expect(at(newPlane, 147, 3)).toBe(9);

  // Keep is durable through the shared workspace: status, stored bytes and
  // the stored annotated source all say the same thing.
  await room.getByTestId("studio-keep").click();
  await expect(room.getByTestId("studio-draft-status")).toHaveText("Kept");
  await room.getByTestId("studio-close").click();
  await expect(room).toHaveCount(0);
  await expect(page.getByTestId("logic-saved-note")).toContainText("Saved to the library");
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await expect(launch).toBeFocused();

  const storedPic = openContainer(await storedFiles(page, projectId)).getResource("picture", 1)!;
  expect(storedPic).toEqual(drawn);
  const storedSource = await storedDocument(page, projectId, "picture:1");
  expect(storedSource).toBe(drawnSource);
  await reviewShot(page, "project-resource-after-keep");

  // Cold reopen: the document is text again with the drawn source.
  await page.getByTestId("logic-close").click();
  await expect(studio).toHaveCount(0);
  await openLogicStudio(page, "Drawn clearing");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-picture:1").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    drawnSource
      .split("\n")
      .find((line) => line.startsWith("polygon"))!
      .trim(),
  );
  expect(providerCalls).toBe(0);
});

test("a VIEW recolour keeps exact bytes while an unrelated dirty LOGIC stays dirty @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Recoloured ego");
  await page.reload();

  const studio = await openLogicStudio(page, "Recoloured ego");
  const explorer = page.getByTestId("logic-explorer");
  const originalBytes = openContainer(await storedFiles(page, projectId)).getResource("view", 0)!;
  const original = openSprite(originalBytes, DEFAULT_V2_PROFILE);
  // The starter ego walks right in loop 0; loop 1 mirrors it.
  expect(original.loops[1]!.alias).toBe(0);
  const originalLoop1 = original.loops[1]!.cels.map((cel) => [...cel.pixels]);

  // An unrelated LOGIC edit stays dirty across the whole visual round trip.
  await explorer.getByTestId("logic-doc-logic:1").click();
  const editor = page.getByTestId("logic-editor");
  await editor.locator(".view-lines").click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type("// an unfinished note");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");

  // VIEW 0 opens in Sprite Studio on the real bytes.
  await explorer.getByTestId("logic-doc-view:0").click();
  const launch = page.getByTestId("logic-resource-edit");
  await expect(launch).toHaveText("Edit sprite");
  await launch.click();
  const sprite = page.getByTestId("sprite-studio");
  await expect(sprite).toBeVisible();
  await expect(sprite.getByTestId("studio-draft-status")).toHaveText("No changes");
  await reviewShot(page, "project-resource-sprite-open");

  // Recolour the loop: the colour under the standing cel's centre (light red) to
  // the next swatch, scoped to this loop.
  await sprite.locator('[data-loop="0"][data-cel="0"]').click();
  await sprite.getByTestId("sprite-stage").focus();
  await page.keyboard.press("c");
  const recolor = sprite.getByTestId("sprite-recolor");
  await expect(recolor).toBeVisible();
  await page.keyboard.press("Space");
  await expect(
    recolor.getByTestId("sprite-recolor-from").getByRole("radio", { checked: true }),
  ).toHaveAttribute("data-colour", "12");
  // To green by swatch name — the keyboard arrow order is not under test here.
  const toColour = 2;
  await recolor.getByRole("radio", { name: "To colour 2, green" }).click();
  const count = await recolor.getByTestId("sprite-recolor-count").textContent();
  const changed = Number(
    /(\d+) pixels? in \d+ cels? will change to colour 2/.exec(count ?? "")?.[1] ?? 0,
  );
  expect(changed).toBeGreaterThan(0);
  await recolor.getByTestId("sprite-recolor-apply").click();
  await expect(sprite.getByTestId("studio-draft-status")).toHaveText("1 change");
  const recoloured = Uint8Array.from(
    await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]),
  );

  await sprite.getByTestId("studio-keep").click();
  await expect(sprite.getByTestId("studio-draft-status")).toHaveText("Kept");
  await sprite.getByTestId("studio-close").click();
  await expect(sprite).toHaveCount(0);

  // The receipt rebased the picture alone: LOGIC 1 is still the dirty one.
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await expect(
    explorer.getByTestId("logic-doc-logic:1").locator(".logic-explorer__dot--dirty"),
  ).toBeVisible();
  // The kept document is bytes now: no stale source claim survives the recolour.
  await expect(explorer.getByTestId("logic-doc-view:0")).toContainText("Bytes");
  expect(await storedDocument(page, projectId, "view:0")).toBeNull();

  // Storage holds the exact reviewed bytes; the mirror still shows the old pixels.
  const storedBytes = openContainer(await storedFiles(page, projectId)).getResource("view", 0)!;
  const stored = openSprite(storedBytes, DEFAULT_V2_PROFILE);
  expect(storedBytes).toEqual(recoloured);
  // The mirror keeps showing its old pixels (it now owns a copy of them);
  // every other loop is byte-identical in display terms.
  expect(stored.loops[1]!.cels.map((cel) => [...cel.pixels])).toEqual(originalLoop1);
  expect(stored.loops[2]!.cels.map((cel) => [...cel.pixels])).toEqual(
    original.loops[2]!.cels.map((cel) => [...cel.pixels]),
  );
  // Loop 0's pixels changed exactly where the colour ran.
  stored.loops[0]!.cels.forEach((cel, index) => {
    const before = original.loops[0]!.cels[index]!;
    cel.pixels.forEach((pixel, i) => {
      expect(pixel).toBe(before.pixels[i] === 12 ? toColour : before.pixels[i]);
    });
  });
  await reviewShot(page, "project-resource-sprite-kept");

  // Cold reopen: the document stays a byte document, no phantom source.
  await page.getByTestId("logic-close").click();
  await page.getByTestId("logic-leave-discard").click();
  await expect(studio).toHaveCount(0);
  await openLogicStudio(page, "Recoloured ego");
  await expect(page.getByTestId("logic-explorer").getByTestId("logic-doc-view:0")).toContainText(
    "Bytes",
  );
  expect(providerCalls).toBe(0);
});

test("child Discard leaves the draft untouched; a stale external write refuses atomically @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Guarded clearing");
  await page.reload();
  await openLogicStudio(page, "Guarded clearing");
  const explorer = page.getByTestId("logic-explorer");
  const originalPic = openContainer(await storedFiles(page, projectId)).getResource("picture", 1)!;

  // Discard: draw, throw it away in the child, and nothing ever happened.
  await explorer.getByTestId("logic-doc-picture:1").click();
  await page.getByTestId("logic-resource-edit").click();
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();
  await room.locator("[data-row]").first().click();
  await room.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(room.getByTestId("studio-draft-status")).toHaveText("1 change");
  await room.getByTestId("studio-discard").click();
  await page.getByTestId("studio-dialog-discard").click();
  await expect(room.getByTestId("studio-draft-status")).toHaveText("No changes");
  await room.getByTestId("studio-close").click();
  await expect(room).toHaveCount(0);
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  expect(openContainer(await storedFiles(page, projectId)).getResource("picture", 1)).toEqual(
    originalPic,
  );

  // A Keep after another workspace committed the same document refuses:
  // the banner stays, the draft keeps the pending edit, nothing is lost.
  await page.getByTestId("logic-resource-edit").click();
  await expect(room).toBeVisible();
  await room.locator("[data-row]").first().click();
  await room.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(room.getByTestId("studio-draft-status")).toHaveText("1 change");
  await page.evaluate(async (id) => {
    const { openEditableProject } = await import("/src/project/editableProject.ts");
    const other = await openEditableProject(id as never);
    const snap = other.draft.capture();
    other.draft.edit("picture:1", "vis 2\nrect 0,0 159,167\nend\n", snap.version("picture:1"));
    await other.keepCandidate(other.buildSelected(["picture:1"]));
  }, projectId);
  await room.getByTestId("studio-keep").click();
  await expect(page.getByTestId("studio-keep-error")).toBeVisible();
  await expect(room.getByTestId("studio-draft-status")).toHaveText("1 change");
  await reviewShot(page, "project-resource-stale-refusal");

  // The recoverable pending edit is real: closing discards the child's copy
  // but the draft document still carries the write, marked as the one change.
  await room.getByTestId("studio-close").click();
  await page.getByTestId("studio-dialog-discard").click();
  await expect(room).toHaveCount(0);
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  await expect(
    explorer.getByTestId("logic-doc-picture:1").locator(".logic-explorer__dot--dirty"),
  ).toBeVisible();
});
