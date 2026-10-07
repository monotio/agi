import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import {
  textHook,
  workspaceUpdated,
  workspaceSaved,
  openLibraryActions,
  savedGameCard,
} from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { workspaceDocument, runningWorkspaceDocument } from "./workspaceShared.ts";

test("Views are static at 0, 50 and 100; dragging drafts LOGIC and Update places it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await expect(slider).toBeVisible();
  await expect(studio.getByTestId("room-views")).toHaveCount(0);
  const initial = await runningWorkspaceDocument(page, "logic:8");
  const initialPicture = await runningWorkspaceDocument(page, "picture:8");
  const history = await page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .history.capture().commits.length,
  );
  for (const value of [50, 100]) {
    await slider.evaluate((el, value) => {
      (el as HTMLInputElement).value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    const layer = studio.getByTestId("room-views");
    await expect(layer).toBeVisible();
    await expect(layer).toHaveCSS("opacity", String(value / 100));
    await page.screenshot({
      path: test.info().outputPath(`views-${value}.png`),
      animations: "disabled",
    });
  }
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("data-x", "60");
  await expect(figure).toHaveAttribute("data-y", "140");
  const pane = (await studio.locator('.studio-pane[data-layer="art"]').boundingBox())!;
  // Grip the centre of a cell inside the figure, in whole pixels: WebKit drops
  // a pointer's fraction, which at a zoom below 100% can land in the next cell.
  const px = (col: number) => Math.round(pane.x + ((col + 0.5) * pane.width) / 160);
  const py = (row: number) => Math.round(pane.y + ((row + 0.5) * pane.height) / 168);
  await page.mouse.move(px(60), py(138));
  await page.mouse.down();
  await page.mouse.move(px(74), py(135), { steps: 4 });
  await page.mouse.up();
  const preview = page.getByTestId("placement-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveText("LOGIC 8 · position(o0, 60, 140) → (74, 137)");
  await page.screenshot({
    path: test.info().outputPath("placement-draft.png"),
    animations: "disabled",
  });
  await expect(
    page.getByRole("tab", { name: /LOGIC 8/ }).getByLabel("Pending change"),
  ).toBeVisible();
  expect(await runningWorkspaceDocument(page, "logic:8")).toBe(initial);
  expect(await workspaceDocument(page, "logic:8")).toContain("position(o0,74,137)");
  await open(page, "part-room:1:picture:1");
  await expect(page.getByTestId("placement-preview")).toBeHidden();
  await open(page, "part-room:8:picture:8");
  await expect(preview).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .drafts()
      .stage([{ key: "picture:8", content: "vis 5\nfill 0,0\nend\n" }]),
  );
  // No floating draft label: the changed cells alone wear a dashed outline.
  await expect(studio.locator(".studio-pane__changed-line").first()).toBeVisible();
  await workspaceUpdated(page);
  await expect
    .poll(async () => {
      const s = await textHook(page);
      return [s.egoX, s.egoY];
    })
    .toEqual([74, 137]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
          .getSession()
          .history.capture().commits.length,
    ),
  ).toBe(history + 1);
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => runningWorkspaceDocument(page, "logic:8")).toBe(initial);
  await expect.poll(() => runningWorkspaceDocument(page, "picture:8")).toBe(initialPicture);
  await expect(studio.locator(".studio-pane__changed-line")).toHaveCount(0);
  await workspaceSaved(page);
  await page.goto("/");
  await openLibraryActions(page, savedGameCard(page, "My adventure"));
  await page.getByTestId("edit-library-game").click();
  const latest = page.getByRole("button", { name: "Start latest", exact: true });
  const heading = page.getByRole("heading", { name: "My adventure", exact: true, level: 1 });
  await expect(heading.or(latest)).toBeVisible();
  if (await latest.isVisible()) await latest.click();
  await expect(heading).toBeVisible();
  await open(page, "part-room:8:picture:8");
  await expect(page.getByRole("slider", { name: "Views", exact: true })).toHaveValue("100");
});

test("computed placements move a preview, and game motion never paints the picture", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.update([
      {
        key: "logic:8",
        content:
          "if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);set.view(o0,8);assignn(v20,60);assignn(v21,140);position.v(o0,v20,v21);draw(o0);program.control();move.obj(o0,120,140,1,f180);accept.input();}return;",
      },
    ]);
  });
  await open(page, "part-room:8:picture:8");
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await page.getByTestId("workspace-update").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  const canvas = studio.locator('.studio-pane[data-layer="art"] canvas');
  await expect(canvas).toBeVisible();
  const pixels = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return {
      width: c.width,
      height: c.height,
      rgba: Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data),
    };
  });
  expect(pixels.width / pixels.height).toBeCloseTo(320 / 168, 1);
  expect(new Set(pixels.rgba.filter((_, index) => index % 4 === 0))).toEqual(new Set([0]));
  expect(new Set(pixels.rgba.filter((_, index) => index % 4 === 1 || index % 4 === 2))).toEqual(
    new Set([170]),
  );
  expect(new Set(pixels.rgba.filter((_, index) => index % 4 === 3))).toEqual(new Set([255]));
  const shot = await canvas.screenshot();
  const before = await textHook(page);
  await expect.poll(async () => (await textHook(page)).egoX).not.toBe(before.egoX);
  expect(await canvas.screenshot()).toEqual(shot);
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await expect(slider).toBeVisible();
  await slider.evaluate((el) => {
    (el as HTMLInputElement).value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // A computed spot draws as in the game, moves a preview, never the line.
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  await expect(figure).toHaveClass(/is-preview/);
  await expect(figure).toHaveAttribute("aria-label", /position\.v uses variables/);
  await page.screenshot({
    path: test.info().outputPath("computed-placement.png"),
    animations: "disabled",
  });
  const source = await workspaceDocument(page, "logic:8");
  const pane = (await studio.locator('.studio-pane[data-layer="art"]').boundingBox())!;
  const px = (col: number) => Math.round(pane.x + ((col + 0.5) * pane.width) / 160);
  const py = Math.round(pane.y + (138.5 * pane.height) / 168);
  await page.mouse.move(px(60), py);
  await page.mouse.down();
  await page.mouse.move(px(70), py, { steps: 4 });
  await page.mouse.up();
  expect(await workspaceDocument(page, "logic:8")).toBe(source);
  await expect(figure).toHaveAttribute("data-x", "70");
  // The Views list shows the preview, with Reset and Copy position.
  await studio
    .getByRole("radiogroup", { name: "Side panel", exact: true })
    .getByRole("radio", { name: "Views", exact: true })
    .click();
  const list = studio.getByTestId("views-panel");
  await expect(list).toBeVisible();
  await expect(list).toContainText("position.v uses variables");
  await expect(list).toContainText("70, 140");
  await list.getByTestId("view-reset").click();
  await expect(figure).toHaveAttribute("data-x", "60");
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .drafts()
      .stage([{ key: "picture:8", content: "vis 4\npri 7\nfill 0,0\nend\n" }]),
  );
  for (const lens of ["Visual", "Priority"]) {
    await studio
      .getByTestId("studio-options-bar")
      .getByRole("radio", { name: lens, exact: true })
      .click();
    await expect(studio.locator(".studio-pane__changed-line").first()).toBeVisible();
  }
});
test("an unfinished bindings draft leaves the picture available", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await expect(slider).toBeVisible();
  await slider.evaluate((el) => {
    (el as HTMLInputElement).value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(studio.locator('[data-object="0"]')).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .drafts()
      .stage([{ key: "bindings", content: "{" }]),
  );
  await expect(studio.locator('[data-object="0"]')).toHaveCount(0);
  await expect(studio.locator("canvas")).toBeVisible();
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`Views stay available in every picture lens at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    await open(page, "part-room:8:picture:8");
    const studio = page.getByTestId("room-studio").filter({ visible: true });
    await expect(studio).toBeVisible();
    const slider = studio.getByRole("slider", { name: "Views", exact: true });
    await expect(slider).toBeVisible();
    await slider.evaluate((el) => {
      (el as HTMLInputElement).value = "100";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const lens of ["Visual", "Priority"]) {
      await studio
        .getByRole("radiogroup", { name: "Lens", exact: true })
        .getByRole("radio", { name: lens, exact: true })
        .click();
      await page.screenshot({
        path: test.info().outputPath(`views-${lens.toLowerCase()}-${size.width}.png`),
        animations: "disabled",
      });
      const figure = studio.locator('[data-object="0"]');
      await expect.soft(figure).toBeVisible();
      await expect.soft(figure).toHaveAttribute("data-x", "60");
      await expect.soft(figure).toHaveAttribute("data-y", "140");
    }
  });
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`picture storyboard ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    await open(page, "part-room:1:picture:1");
    const studio = page.getByTestId("room-studio").filter({ visible: true });
    await expect(studio).toBeVisible();
    const take = async (name: string) => {
      await page.screenshot({
        path: test.info().outputPath(`${name}.png`),
        animations: "disabled",
      });
    };
    await take("picture");
    if (size.width > 600) {
      // Stacked is the default: the toggle turns Side by side on.
      const layout = page.getByTestId("workspace-layout");
      await expect(layout).toBeVisible();
      if ((await layout.getAttribute("aria-pressed")) === "true") await layout.click();
      await take("stacked");
      const frame = page.getByTestId("workspace-editor");
      await expect(frame).toBeVisible();
      const picture = (await frame.boundingBox())!;
      const game = (await page.locator(".play-area").boundingBox())!;
      expect(picture.y).toBeGreaterThan(game.y);
      expect(picture.width).toBeCloseTo(game.width, 0);
      const side = studio.locator(".studio__side");
      const items = side.locator(".scene-list");
      await expect(items).toBeVisible();
      const sidebar = (await side.boundingBox())!;
      const list = (await items.boundingBox())!;
      expect(list.y + list.height).toBeLessThanOrEqual(sidebar.y + sidebar.height);
      const firstItem = items.locator('[role="treeitem"]').first();
      await expect(firstItem).toBeVisible();
      const first = (await firstItem.boundingBox())!;
      const rows = (await items.getByRole("tree").boundingBox())!;
      expect(rows.height).toBeGreaterThanOrEqual(first.height);
      expect(first.y + first.height).toBeLessThanOrEqual(rows.y + rows.height);
      await page.getByTestId("workspace-focus").click();
      await expect(page.getByTestId("workspace-show-game")).toBeVisible();
      await expect(page.getByTestId("workspace-show-game")).toHaveText("Game · Room 1 · Show");
      await expect(page.locator(".play-area")).toBeHidden();
      await take("focus");
      await page.getByTestId("workspace-focus").click();
      await expect(page.locator(".play-area")).toBeVisible();
      await expect(page.getByTestId("workspace-layout")).toHaveAttribute("aria-pressed", "false");
    } else {
      await page.getByRole("button", { name: "Playtest", exact: true }).click();
      await expect(page.locator(".play-area")).toBeVisible();
      await take("playtest");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
    }
    await open(page, "part-picture:9");
    await expect(page.getByTestId("workspace-unused")).toBeVisible();
    await take("unused");
  });
}

test("Make it a room Undo reviews computed jumps after restoring the latest draft @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    await session.update([
      { key: "logic:99", content: 'get.num("Room",v20);new.room.v(v20);return;' },
    ]);
  });
  await open(page, "part-picture:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await page.getByRole("button", { name: "Make it a room", exact: true }).click();
  await workspaceUpdated(page);
  await open(page, "part-room:2:picture:9");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await page.getByTestId("workspace-undo").click();
  const dialog = page.getByRole("dialog", { name: "Remove room", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Room 2 can still be reached by a computed room jump in LOGIC 99 (the debug teleport). Remove anyway?",
  );
  await page.screenshot({
    path: test.info().outputPath("room-removal-review.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Keep it", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await textHook(page)).room).toBe(2);
  await page.getByTestId("workspace-undo").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove anyway", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await textHook(page)).room).toBe(2);
  await open(page, "part-room:1:logic");
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await page.getByTestId("workspace-update").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await open(page, "part-picture:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .model.capture()
        .read("logic:2"),
    ),
  ).toBeUndefined();
  await page.getByTestId("workspace-redo").click();
  await open(page, "part-room:2:picture:9");
  await page.getByTestId("workspace-update").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await page.getByTestId("btn-world-map").click();
  const map = page.getByTestId("world-map");
  await expect(map).toBeVisible();
  await expect(map.getByTestId("map-runtime-exits")).toBeVisible();
  await expect(map.getByTestId("map-runtime-exits")).toContainText(
    "A computed room jump can reach a missing room.",
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .drafts()
      .stage([{ key: "logic:99", content: "new.room(2);return;" }]),
  );
  await page.getByTestId("workspace-undo").click();
  await expect(dialog).toBeHidden();
  const source = await page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .workingSnapshot()
        .read("logic:99")?.content,
  );
  expect(source).toBe('get.num("Room",v20);new.room.v(v20);return;');
  await page.getByTestId("workspace-undo").click();
  await expect(dialog).toBeVisible();
  expect((await textHook(page)).room).toBe(2);
});

test("picture-only editor sits beside the game with a Views slider", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  await expect(studio.locator(".play-area")).toHaveCount(0);
  await expect(studio).not.toHaveClass(/is-live-game/);
  await expect(page.locator(".play-area:visible")).toBeVisible();
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveValue("0");
});

test("unused art leaves the game running in its room", async ({ page }) => {
  await start(page);
  const before = await textHook(page);
  await open(page, "part-picture:9");
  await expect(page.getByTestId("workspace-unused")).toBeVisible();
  await expect(page.locator(".play-area:visible")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  expect((await textHook(page)).room).toBe(before.room);
});

test("the picture fits its 1063px side panel", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  const canvas = studio.locator('.studio-pane[data-layer="art"]');
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox())!.width).toBeLessThanOrEqual(
    (await studio.locator(".studio__frame").boundingBox())!.width,
  );
  const frame = (await page.getByTestId("workspace-editor").boundingBox())!;
  const tabs = page.getByTestId("project-studio-tabs");
  await expect(tabs).toBeVisible();
  const tab = tabs.getByRole("tab", { name: /PICTURE 1/ });
  await expect(tab).toBeVisible();
  expect((await tab.boundingBox())!.width).toBeLessThanOrEqual((await tabs.boundingBox())!.width);
  const side = studio.locator(".studio__side");
  await expect(side).toBeVisible();
  const edge = (await side.boundingBox())!;
  expect(edge.x + edge.width).toBeLessThanOrEqual(frame.x + frame.width);
  const order = studio.getByRole("button", { name: "Draw order", exact: true });
  await expect(order).toBeVisible();
  const control = (await order.boundingBox())!;
  expect.soft(control.x + control.width).toBeLessThanOrEqual(frame.x + frame.width);
  for (const name of ["Zoom out", "Zoom in", "Zoom to fit"]) {
    // Zoom rides the shared status bar; keep it inside the window.
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect.soft(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  // The one Keys button lives on the workspace tab bar.
  await expect(page.getByTestId("workspace-keys")).toBeVisible();
  const sun = studio.locator('[role="treeitem"][data-row="sun"]');
  await expect(sun).toBeVisible();
  await sun.click();
  const kind = studio.getByRole("radiogroup", { name: "Kind", exact: true });
  await expect(kind).toBeVisible();
  for (const button of await kind.getByRole("radio").all()) {
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect.soft(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
  }
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  const startWalk = studio.locator('[data-role="test-walk"] button').first();
  await expect(startWalk).toBeVisible();
  const startBox = (await startWalk.boundingBox())!;
  expect(startBox.x + startBox.width).toBeLessThanOrEqual(frame.x + frame.width);
});

test("phone Edit and Playtest alternate the picture and game; Update plays", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  await expect(page.getByTestId("room-studio")).toBeVisible();
  const play = page.getByRole("button", { name: "Playtest", exact: true });
  await expect(play).toBeVisible();
  await play.click();
  await expect(page.locator(".play-area")).toBeVisible();
  await expect(page.getByTestId("workspace-editor")).toBeHidden();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByTestId("workspace-editor")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
      .getSession()
      .drafts()
      .stage([{ key: "picture:1", content: "vis 3\nfill 0,0\nend\n" }]);
  });
  await workspaceUpdated(page);
  await expect(page.locator(".play-area")).toBeVisible();
  await expect(page.getByTestId("workspace-editor")).toBeHidden();
});
