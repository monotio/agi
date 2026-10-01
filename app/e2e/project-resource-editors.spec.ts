import { storedDocument } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { createPictureSurface } from "../../src/types.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import {
  closeWorkspaceEditor,
  isolateStorage,
  openLibraryActions,
  openWorkspacePicture,
  openWorkspaceView,
  savedGameCard,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";
import { replaceWorkspaceDocument, workspaceDocument } from "./workspaceShared.ts";

/** Exact resource edits autosave into one project and survive a cold library reopen. */
test.use({ viewport: { width: 1440, height: 900 } });

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
  await expect(page.getByTestId("parts-list")).toBeVisible();
  return page.getByTestId("workspace-editor");
}

test("a starter PICTURE autosaves exact pixels and source and reopens cold @webkit-desktop", async ({
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
  await openLogicStudio(page, "Drawn clearing");
  const room = await openWorkspacePicture(page, 1);
  const before = Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
  const beforeSource = await page.evaluate(() => window.__AGI_STUDIO__!.source());
  await reviewShot(page, "project-resource-room-open");

  // A keyboard nudge of the first item: the sun moves one row down.
  await room.locator("[data-row]").first().click();
  await room.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await workspaceSaved(page);
  const drawnSource = await page.evaluate(() => window.__AGI_STUDIO__!.source());
  expect(drawnSource).not.toBe(beforeSource);
  const drawn = Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
  expect(drawn).toEqual(compilePictureSource(drawnSource, { profile: DEFAULT_V2_PROFILE }).bytes);
  // The sun's old top row becomes sky.
  const [oldPlane, newPlane] = [visual(before), visual(drawn)];
  expect(at(oldPlane, 147, 3)).toBe(14);
  expect(at(newPlane, 147, 3)).toBe(9);

  // Autosave stores the source and compiled picture together.
  await workspaceSaved(page);
  await closeWorkspaceEditor(page);
  await expect(room).toBeHidden();
  const storedPic = openContainer(await storedFiles(page, projectId)).getResource("picture", 1)!;
  expect(storedPic).toEqual(drawn);
  const storedSource = await storedDocument(page, projectId, "picture:1");
  expect(storedSource).toBe(drawnSource);
  await reviewShot(page, "project-resource-after-keep");

  await page.getByTestId("btn-exit").click();
  await openLogicStudio(page, "Drawn clearing");
  await openWorkspacePicture(page, 1);
  expect(await page.evaluate(() => window.__AGI_STUDIO__!.source())).toBe(drawnSource);
  expect(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()])).toEqual([...drawn]);
  expect(providerCalls).toBe(0);
});

test("a VIEW recolour autosaves exact bytes and retains an unrelated LOGIC edit @webkit-desktop", async ({
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
  await openLogicStudio(page, "Recoloured ego");
  const originalBytes = openContainer(await storedFiles(page, projectId)).getResource("view", 0)!;
  const original = openSprite(originalBytes, DEFAULT_V2_PROFILE);
  // The starter ego walks right in loop 0; loop 1 mirrors it.
  expect(original.loops[1]!.alias).toBe(0);
  const originalLoop1 = original.loops[1]!.cels.map((cel) => [...cel.pixels]);

  const source = await workspaceDocument(page, "logic:1");
  const editedSource = source + "\n// an unfinished note";
  await replaceWorkspaceDocument(page, "logic:1", editedSource);
  const sprite = await openWorkspaceView(page, 0);
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
  await workspaceSaved(page);
  const recoloured = Uint8Array.from(
    await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]),
  );

  await workspaceSaved(page);
  await closeWorkspaceEditor(page);
  await expect(sprite).toBeHidden();
  expect(await workspaceDocument(page, "logic:1")).toBe(editedSource);
  expect(await storedDocument(page, projectId, "logic:1")).toBe(editedSource);
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

  await page.getByTestId("btn-exit").click();
  await openLogicStudio(page, "Recoloured ego");
  await openWorkspaceView(page, 0);
  expect(await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()])).toEqual([...recoloured]);
  expect(await workspaceDocument(page, "logic:1")).toBe(editedSource);
  expect(providerCalls).toBe(0);
});
