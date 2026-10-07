import { workspaceDocument, openWorkspaceLogic, clickPictureCell } from "./workspaceShared.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import {
  enterCreateMode,
  openGameOptions,
  isolateStorage,
  waitForRoom,
  workspaceUpdated,
  workspaceSaved,
} from "./engineProbe.ts";

async function picture(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
  if (page.viewportSize()!.width <= 600) await page.getByTestId("workspace-parts").click();
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}
async function cell(page: Page, x: number, y: number) {
  const pane = page.locator(".studio-pane").last();
  // The workspace can still be settling (the game revealing, the tool bar
  // growing): a box measured mid-transition gives stale click points.
  await expect(async () => {
    const before = (await pane.boundingBox())!;
    await page.waitForTimeout(80);
    expect(await pane.boundingBox()).toEqual(before);
  }).toPass();
  const box = (await pane.boundingBox())!;
  return { x: box.x + ((x + 0.5) * box.width) / 160, y: box.y + ((y + 0.5) * box.height) / 168 };
}
for (const width of [1063, 1440, 390]) {
  test.describe(`${width} PICTURE`, () => {
    test.use({ hasTouch: width === 390 });
    test(`PICTURE inspector and metadata fit ${width}`, async ({ page }) => {
      await page.setViewportSize({
        width,
        height: width === 1063 ? 815 : width === 1440 ? 900 : 844,
      });
      const studio = await picture(page);
      if (width === 1440) {
        await expect(page.locator(".play-area")).toBeVisible();
        const game = (await page.locator(".play-area").boundingBox())!;
        const editor = (await page.getByTestId("workspace-editor").boundingBox())!;
        // Stacked is the default arrangement: the editor sits under the game.
        expect(editor.y).toBeGreaterThanOrEqual(game.y + game.height);
        expect(editor.width).toBeCloseTo(game.width, 0);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: test.info().outputPath(`picture-${width}.png`) });
      await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
      await expect(studio.locator(".studio__inspector")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`inspector-${width}.png`) });
      // Size and the AGI profile sit quietly in the shared status bar.
      const status = page.getByTestId("workspace-status");
      await expect(status).toContainText("bytes");
      await expect(status).toContainText("AGI 2.936");
      // Share is a rare action in the frame's ⋯ menu.
      await page.getByTestId("workspace-more").click();
      await expect(page.getByTestId("studio-share-still")).toBeVisible();
      await page.keyboard.press("Escape");
    });
  });
}
test.describe("phone Items", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("Items rows remain visible and select an item on a phone", async ({ page }) => {
    const studio = await picture(page);
    const row = studio.locator('[role="treeitem"][data-row]').first();
    // The transport sits under the canvas; on a phone the Items list scrolls to it.
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    await row.evaluate(() => document.fonts.ready);
    await row.click({ trial: true });
    await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(row).toBeInViewport({ ratio: 1 });
    await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
    const bust = studio.locator('[role="treeitem"][data-row]').first();
    await expect(bust).toBeVisible();
    await bust.click();
    await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
    await expect(studio.getByTestId("item-label")).toBeVisible();
    await expect(studio.getByTestId("item-label")).toHaveValue("Marble bust");
    await expect(page.getByTestId("studio-status")).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("phone-selected-item.png") });
  });
});
for (const width of [1063, 1440, 390]) {
  test.describe(`${width} Rebuilt`, () => {
    test.use({
      viewport: { width, height: width === 1063 ? 815 : width === 1440 ? 900 : 844 },
      hasTouch: width === 390,
    });
    test("a native picture explains its Rebuilt source in the workspace", async ({ page }) => {
      await picture(page);
      const bytes = openContainer(new Map(Object.entries(buildTutorial().files))).getResource(
        "picture",
        1,
      )!;
      await page.evaluate(
        async (payload) => {
          const session = (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__.getSession();
          await session.submit({
            proposal: session.model.propose(session.model.capture(), "Native picture", [
              { key: "picture:1", content: new Uint8Array(payload) },
            ]),
            label: "Native picture",
            origin: "picture",
            author: "creator",
          });
        },
        [...bytes],
      );
      // The first accepted edit saves a personal copy and updates the workspace header.
      await workspaceSaved(page);
      await expect(page).toHaveURL(/#create\/remix-/);
      const rebuilt = page.getByTestId("studio-source-kind");
      await expect(rebuilt).toBeVisible();
      await expect(rebuilt).toContainText("Rebuilt");
      const term = rebuilt.locator('[data-term="rebuilt"]');
      await expect(term).toBeVisible();
      if (width === 390) await term.tap();
      else await term.click();
      const pop = page.getByTestId("explain-pop");
      await expect(pop).toBeVisible();
      await pop.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      await expect(pop).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("rebuilt-picture.png") });
    });
  });
}
test("Focus gives the PICTURE canvas more room", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  const studio = await picture(page);
  const before = (await studio.locator(".studio__stage").boundingBox())!;
  await page.getByTestId("workspace-focus").click();
  const after = (await studio.locator(".studio__stage").boundingBox())!;
  expect(after.width * after.height).toBeGreaterThan(before.width * before.height * 1.2);
});
test("draw order, Split and Distance bands are reachable in the workspace", async ({ page }) => {
  const studio = await picture(page);
  // The draw-order transport is on by default; the Items list's Draw order only sorts the list.
  await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
  await studio.getByRole("button", { name: "Draw order", exact: true }).click();
  await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
  await studio
    .getByTestId("studio-options-bar")
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  await studio.getByRole("radio", { name: "Split", exact: true }).click();
  await expect(studio.locator(".studio-pane")).toHaveCount(2);
  await expect(studio.getByRole("button", { name: "Band lines", exact: true })).toBeVisible();
});
/**
 * Everything showing on the picture's rect that is not the picture's own
 * layers (its pixels, its overlay in picture coordinates and the open path's
 * points): a button, a hint or a label over the picture, even one the pointer
 * passes through.
 */
async function overPicture(studio: Locator): Promise<string[]> {
  return studio
    .locator(".studio-pane")
    .last()
    .evaluate((pane) => {
      const box = pane.getBoundingClientRect();
      const own = ".studio-pane__pixels, .studio-pane__overlay, .tool-overlay";
      const found: string[] = [];
      for (const element of document.body.querySelectorAll("*")) {
        if (element.contains(pane) || element.closest(own)) continue;
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        // What shows of it: its box, cut by every scrolling or clipping box around it.
        const r = element.getBoundingClientRect();
        let { left, top, right, bottom } = r;
        for (let up = element.parentElement; up; up = up.parentElement) {
          if (getComputedStyle(up).overflow === "visible") continue;
          const clip = up.getBoundingClientRect();
          left = Math.max(left, clip.left);
          top = Math.max(top, clip.top);
          right = Math.min(right, clip.right);
          bottom = Math.min(bottom, clip.bottom);
        }
        if (right <= left || bottom <= top) continue;
        if (right <= box.left || left >= box.right || bottom <= box.top || top >= box.bottom)
          continue;
        found.push(
          `${element.tagName.toLowerCase()}.${element.getAttribute("class")}: ${element.textContent}`,
        );
      }
      return found;
    });
}
async function clickPoints(studio: Locator, points: readonly (readonly [number, number])[]) {
  for (const [x, y] of points) await clickPictureCell(studio, x, y);
}
const LINE = [
  [40, 110],
  [60, 115],
  [70, 120],
] as const;
test("while a line is open only its points sit on the picture; Done, Enter and a double-click finish it @webkit-desktop", async ({
  page,
}) => {
  const studio = await picture(page);
  const context = page.getByTestId("workspace-context");
  const lines = () =>
    workspaceDocument(page, "picture:1").then((text) => text.match(/^line /gm)?.length ?? 0);
  const before = await lines();
  await studio.locator('button[data-tool="line"]').click();
  await clickPoints(studio, LINE);
  // The cursor moves on past the last point: the next segment is the picture's own pixels.
  const pane = studio.locator(".studio-pane").last();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + (100.5 * box.width) / 160, box.y + (130.5 * box.height) / 168);
  const path = context.getByTestId("studio-path");
  await expect(path).toBeVisible();
  await expect(path).toContainText("Line · 3 points");
  expect(await overPicture(studio)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("line-open.png") });
  const undo = path.getByRole("button", { name: "Undo point", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(path).toContainText("Line · 2 points");
  await clickPictureCell(studio, 70, 120);
  const done = path.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  await done.click();
  await expect(path).toHaveCount(0);
  await expect.poll(lines).toBe(before + 1);

  // Enter finishes the next one, a double-click on its last point the one after.
  await clickPoints(studio, [
    [40, 130],
    [60, 135],
  ]);
  await expect(path).toContainText("Line · 2 points");
  await page.keyboard.press("Enter");
  await expect(path).toHaveCount(0);
  await expect.poll(lines).toBe(before + 2);
  await clickPictureCell(studio, 40, 150);
  const end = await pane.boundingBox();
  await pane.dblclick({
    position: { x: (60.5 * end!.width) / 160, y: (150.5 * end!.height) / 168 },
  });
  await expect(path).toHaveCount(0);
  await expect.poll(lines).toBe(before + 3);
  await workspaceUpdated(page);
});
test("a polygon finishes with Done in the context row and its point menu names Delete shape", async ({
  page,
}) => {
  const studio = await picture(page);
  const polygon = studio.locator('button[data-tool="polygon"]');
  await polygon.click();
  await expect(polygon).toHaveAttribute("aria-pressed", "true");
  await clickPoints(studio, [
    [40, 110],
    [70, 110],
    [70, 140],
    [40, 140],
  ]);
  const path = page.getByTestId("workspace-context").getByTestId("studio-path");
  await expect(path).toBeVisible();
  await expect(path).toContainText("Polygon · 4 points");
  expect(await overPicture(studio)).toEqual([]);
  const done = path.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  await done.click();
  await expect(path).toHaveCount(0);
  await workspaceUpdated(page);
  const point = studio.locator('button[data-tool="point"]');
  await point.click();
  await expect(point).toHaveAttribute("aria-pressed", "true");
  const handles = studio.locator("[data-point]");
  await expect(handles).toHaveCount(4);
  await handles.nth(1).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete shape", exact: true })).toBeVisible();
  const remove = page.getByRole("menuitem", { name: "Delete point", exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(handles).toHaveCount(3);
  await workspaceUpdated(page);
});
test.describe("phone drawing", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const tool of ["line", "polygon"] as const)
    test(`a ${tool} drawn on a phone keeps the picture clear and finishes with Done above it`, async ({
      page,
    }) => {
      const studio = await picture(page);
      await studio.locator(`button[data-tool="${tool}"]`).click();
      const pane = studio.locator(".studio-pane").last();
      await clickPictureCell(studio, 40, 110);
      // The first point never moves the picture: the next tap lands where it is aimed.
      const first = (await pane.boundingBox())!;
      await clickPoints(studio, [
        [80, 100],
        [90, 140],
      ]);
      expect(await pane.boundingBox()).toEqual(first);
      const path = page.getByTestId("workspace-context").getByTestId("studio-path");
      await expect(path).toBeVisible();
      await expect(path).toContainText(`${tool === "line" ? "Line" : "Polygon"} · 3 points`);
      await expect(path).toBeInViewport();
      expect(await overPicture(studio)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`phone-${tool}-open.png`) });
      const done = path.getByRole("button", { name: "Done", exact: true });
      await expect(done).toBeVisible();
      await done.tap();
      await expect(path).toHaveCount(0);
      await workspaceUpdated(page);
    });
});
test("the Priority lens shows doors and runs a real test with Play here", async ({ page }) => {
  const studio = await picture(page);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  await expect(studio.getByTestId("walk-panel")).toBeVisible();
  await expect(studio.getByTestId("walk-door").first()).toBeVisible();
  await studio.locator('[data-role="test-walk"] button').first().click();
  for (const [x, y] of [
    [80, 140],
    [100, 140],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await expect(studio.getByTestId("walk-result")).toBeVisible();
  await expect(studio.getByTestId("walk-result-title")).toBeVisible();
  await expect(studio.getByTestId("walk-result-title")).toHaveText("Reached");
  const status = page.locator(".studio__status");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Reached");
  await expect(studio.getByTestId("walk-play-here")).toBeVisible();
  await studio.getByTestId("walk-play-here").click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await studio.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(status).not.toContainText("Now click the goal");
});
test("Create Inspector opens screen, state and timeline controls", async ({ page }) => {
  await picture(page);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("settings-advanced").click();
  await page.getByTestId("settings-inspect").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspect-panel")).toBeVisible();
  for (const tab of ["state", "timeline", "screen"]) {
    await expect(page.getByTestId(`dbg-tab-${tab}`)).toBeVisible();
    await page.getByTestId(`dbg-tab-${tab}`).click();
  }
  await expect(page.getByTestId("dbg-mode-priority")).toBeVisible();
  await page.getByTestId("dbg-mode-priority").click();
  await expect(page.getByTestId("dbg-mode-blend")).toBeVisible();
  await page.getByTestId("dbg-mode-blend").click();
  await expect(page.getByTestId("dbg-mode-note")).toBeVisible();
  await expect(page.getByTestId("dbg-mode-note")).toHaveText(
    "Depth shading over the game, with control lines hatched",
  );
  await page.screenshot({ path: test.info().outputPath("game-inspector.png") });
});
test("splitter saves once on release and keeps the game buffer during drag", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await picture(page);
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor").locator(".monaco-editor")).toBeVisible();
  const separator = page.getByRole("separator", { name: "Editor height" });
  await expect(separator).toBeVisible();
  const before = await page.evaluate(() => ({
    stored: localStorage.getItem("monotio_agi.workspaceSplit"),
    width: document.querySelector<HTMLCanvasElement>('[data-testid="gpu-canvas"]')!.width,
  }));
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 160, { steps: 20 });
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.workspaceSplit"))).toBe(
    before.stored,
  );
  expect(
    await page.getByTestId("gpu-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBe(before.width);
  await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.workspaceSplit"))).not.toBe(
    before.stored,
  );
});

async function drawLine(page: Page) {
  const studio = await picture(page);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await studio.locator('button[data-tool="line"]').click();
  for (const [x, y] of [
    [40, 110],
    [60, 115],
    [70, 120],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  const done = page.getByTestId("studio-path").getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  await done.click();
  await workspaceUpdated(page);
  return studio;
}

test("item inspector saves name, colour, Lock and points and seeks a pixel's step", async ({
  page,
}) => {
  const studio = await drawLine(page);
  await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
  const name = studio.getByTestId("item-label");
  await expect(name).toBeVisible();
  await name.fill("Ridge");
  await name.press("Enter");
  const colour = studio
    .getByRole("radiogroup", { name: "Visual colour", exact: true })
    .getByRole("radio", { name: /^Colour 12,/ });
  await expect(colour).toBeVisible();
  await colour.click();
  await expect(colour).toHaveAttribute("aria-checked", "true");
  await studio.getByTestId("item-lock").click();
  await expect(studio.getByTestId("item-lock")).toHaveAttribute("aria-pressed", "true");
  await expect(colour).toBeDisabled();
  await studio.getByTestId("item-lock").click();
  await studio.getByTestId("inspector-details").click();
  const x = studio.getByRole("spinbutton", { name: /^Point 1 of line .* x$/ });
  await expect(x).toBeVisible();
  await x.fill("61");
  await x.press("Tab");
  await expect(x).toHaveValue("61");
  await studio.locator('button[data-tool="select"]').click();
  const p = await cell(page, 40, 110);
  await page.mouse.click(p.x, p.y);
  const pixel = studio.locator('[data-role="pixel"]');
  await expect(pixel).toBeVisible();
  const writer = pixel.locator('button[title="Scrub to this step"]').first();
  await expect(writer).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("item-inspector.png") });
  await writer.click();
  await workspaceUpdated(page);
});

for (const key of ["Delete", "Backspace"] as const) {
  test(`${key} removes the selected line vertex`, async ({ page }) => {
    const studio = await drawLine(page);
    await studio.locator('button[data-tool="point"]').click();
    const handles = studio.locator("[data-point]");
    await expect(handles).toHaveCount(3);
    await handles.nth(1).click();
    await page.keyboard.press(key);
    await expect(handles).toHaveCount(2);
    await workspaceUpdated(page);
  });
}
test("a point's context menu offers Delete point and Delete line", async ({ page }) => {
  const studio = await drawLine(page);
  await studio.locator('button[data-tool="point"]').click();
  const handles = studio.locator("[data-point]");
  await expect(handles).toHaveCount(3);
  await handles.nth(1).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete line", exact: true })).toBeVisible();
  const remove = page.getByRole("menuitem", { name: "Delete point", exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(handles).toHaveCount(2);
});

test("Share picture downloads a Still and a Clip when recording is supported", async ({ page }) => {
  await picture(page);
  for (const kind of ["still", "clip"] as const) {
    await page.getByTestId("workspace-more").click();
    await expect(page.getByTestId(`studio-share-${kind}`)).toBeVisible();
    if (kind === "clip") {
      const supported = await page.evaluate(async () => {
        const path = "/src/studio/share/renderClip.ts";
        return (await import(path)).clipType() !== null;
      });
      if (!supported) {
        await expect(page.getByTestId("studio-share-clip")).toBeDisabled();
        await expect(page.getByTestId("studio-share-clip")).toHaveAttribute(
          "title",
          "Video recording is unavailable in this browser",
        );
        await page.keyboard.press("Escape");
        continue;
      }
    }
    await page.getByTestId(`studio-share-${kind}`).click();
    const dialog = page.getByTestId("studio-share-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("studio-share-file").waitFor({ state: "visible" });
    await expect(dialog.getByTestId("studio-share-file")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`share-${kind}.png`) });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Download", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(kind === "still" ? /\.png$/ : /\.(webm|mp4)$/);
    expect(await download.failure()).toBeNull();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
});

test("Walk edits a door box and an edge exit and shows drawing errors beside the controls", async ({
  page,
}) => {
  const studio = await picture(page);
  // The zoom control rides the shared status bar.
  const level = page.locator(".studio-zoom__level");
  await expect(level).toBeVisible();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(level).toHaveText("100%");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(level).toHaveText("200%");
  const focus = page.getByTestId("workspace-focus");
  await expect(focus).toBeVisible();
  await focus.click();
  await expect(page.locator(".play-area")).toBeHidden();
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  const door = studio.locator('button[data-tool="door"]');
  await expect(door).toBeVisible();
  await expect(door).toBeEnabled();
  await door.click();
  const from = await cell(page, 120, 130),
    to = await cell(page, 145, 150);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(studio.locator('[data-testid="walk-door"][data-door="door-1"]')).toBeVisible();
  await focus.click();
  await expect(page.locator(".play-area")).toBeVisible();
  const box = studio.getByTestId("door-box-x1");
  await expect(box).toBeVisible();
  await box.fill("121");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        return session.workingSnapshot().read("logic:1")?.content;
      }),
    )
    .toContain("posn(o0, 120, 130, 145, 150)");
  await expect(box, "the saved draft preserves text before blur").toHaveValue("121");
  await box.press("Tab");
  await expect(box).toHaveValue("121");
  await workspaceUpdated(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        return session.capture().snapshot.lastAdmissibleBuild?.documents()["logic:1"];
      }),
    )
    .toContain("posn(o0, 121, 130, 145, 150)");
  const right = studio.getByTestId("door-box-x2");
  await right.fill("999");
  await right.press("Tab");
  await expect(page.getByTestId("studio-notice")).toContainText("Door edit rejected");
  await expect(right, "a refused field keeps the text for correction").toHaveValue("999");
  await right.fill("144");
  await right.press("Tab");
  await workspaceUpdated(page);
  await expect(box).toHaveValue("121");
  await expect(right).toHaveValue("144");
  await focus.click();
  await expect(page.locator(".play-area")).toBeHidden();
  const edge = studio.locator('button[data-tool="edge"]');
  await expect(edge).toBeVisible();
  await edge.click();
  const left = await cell(page, 0, 140);
  await page.mouse.click(left.x, left.y);
  await expect(studio.locator('[data-testid="walk-door"][data-door="exit-west-1"]')).toBeVisible();
  await workspaceUpdated(page);
  await door.click();
  const spot = await cell(page, 120, 130);
  await page.mouse.click(spot.x, spot.y);
  const notice = page.getByTestId("studio-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("needs some width and height");
  await page.screenshot({ path: test.info().outputPath("walk-doors.png") });
});

test("a door keeps an unfinished box number when its saved LOGIC refreshes", async ({ page }) => {
  const studio = await picture(page);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  await studio.locator('button[data-tool="door"]').click();
  const from = await cell(page, 120, 130),
    to = await cell(page, 145, 150);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const box = studio.getByTestId("door-box-x1");
  await expect(box).toBeVisible();
  await workspaceUpdated(page);
  await box.fill("121");
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const snapshot = session.model.capture();
    await session.submit({
      proposal: session.model.propose(snapshot, "Add a room note", [
        { key: "logic:1", content: `${snapshot.read("logic:1")!.content}\n// A room note\n` },
      ]),
      label: "Add a room note",
      origin: "logic",
      author: "creator",
    });
  });
  await workspaceUpdated(page);
  await expect(box).toHaveValue("121");
  await box.press("Tab");
  await workspaceUpdated(page);
  await expect(box).toHaveValue("121");
});

test("stand-in readout and an item's depth controls are reachable", async ({ page }) => {
  const studio = await picture(page);
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
  await studio.locator('[role="treeitem"][data-row]').first().click();
  await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
  await studio
    .getByTestId("studio-options-bar")
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  const pen = studio.getByRole("radiogroup", { name: "Priority pen", exact: true });
  const distance = pen.getByRole("radio", { name: "Distance", exact: true });
  await expect(distance).toBeVisible();
  await distance.click();
  await expect(distance).toHaveAttribute("aria-checked", "true");
  const band = studio.getByRole("slider", { name: "Distance band", exact: true });
  await expect(band).toBeVisible();
  await band.fill("8");
  await expect(band).toHaveValue("8");
  await studio.getByTestId("studio-probe-toggle").click();
  await expect(studio.getByTestId("ghost-probe-readout")).toBeVisible();
});

test("an empty picture names the next drawing action", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await workspaceUpdated(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession();
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Blank picture", [
        { key: "picture:1", content: "end" },
      ]),
      label: "Blank picture",
      origin: "picture",
      author: "creator",
    });
  });
  await page.getByTestId("part-room:1:picture:1").click();
  const empty = page.locator(".scene-list__empty");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText("Nothing drawn yet. Pick a tool to start.");
});

test("drawing preserves invalid room LOGIC and Walk refuses to overwrite it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await picture(page);
  const source = (await workspaceDocument(page, "logic:1")) + "\nunknown.opcode();";
  await page.evaluate(async (source) => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.stage([{ key: "logic:1", content: source }]);
    await session.drafts().flush();
  }, source);
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await studio.locator('button[data-tool="line"]').click();
  for (const [x, y] of [
    [40, 110],
    [60, 115],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await page.getByTestId("studio-path").getByRole("button", { name: "Done", exact: true }).click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  await studio.locator('button[data-tool="door"]').click();
  const from = await cell(page, 120, 130),
    to = await cell(page, 145, 150);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const notice = page.getByTestId("studio-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Fix the room’s LOGIC before changing its doors.");
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
});

// The retired live-edit tip is replaced by the Update game count, dots and
// private stage overlay assertions in workspace-update.spec.ts.

test("drawing cannot resubmit a door edit over a newer pending LOGIC draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const studio = await picture(page);
  const source = "// Newer pending room text.\nreturn;\nunknown.opcode();";
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  await studio.locator('button[data-tool="door"]').click();
  const from = await cell(page, 120, 130),
    to = await cell(page, 145, 150);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await workspaceSaved(page);
  const logicEditor = await openWorkspaceLogic(page);
  // WebKit needs Monaco's rendered surface to own the keyboard before selection.
  await logicEditor.locator(".view-lines").click();
  // Monaco follows the user agent; Linux WebKit identifies as Macintosh.
  const mac = await page.evaluate(() => /Macintosh|Mac OS X/i.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+a" : "Control+a");
  await expect(
    page
      .getByTestId("workspace-logic-editor")
      .filter({ visible: true })
      .locator(".selected-text")
      .first(),
  ).toBeVisible();
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(source);
  await page.keyboard.press("Escape");
  await page.getByTestId("part-room:1:picture:1").click();
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Visual", exact: true })
    .click();
  await studio.locator('button[data-tool="line"]').click();
  for (const [x, y] of [
    [40, 110],
    [60, 115],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await page.getByTestId("studio-path").getByRole("button", { name: "Done", exact: true }).click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
});
