import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { enterCreateMode, isolateStorage, waitForRoom } from "./engineProbe.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { workspaceDocument } from "./workspaceShared.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

/**
 * The picture editor's calm storyboard in the real app: Sierra's two layers,
 * where new shapes draw (the frame's context row and "insert here"), the
 * Items list's Draw order, the Priority pen, Stand in the room, and the
 * room's views (Set in, Copy position, previews for unknown spots).
 */

/** Room 1's picture (or `part`) in the starter game, open in the frame. */
async function picture(
  page: Page,
  part = "part-room:1:picture:1",
  size = { width: 1440, height: 900 },
) {
  await page.setViewportSize(size);
  await start(page);
  await open(page, part);
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  return studio;
}

/** Room 1's picture of the catalog game, whose art has groups, fills and a Marble bust. */
async function catalog(page: Page, size = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
  await open(page, "part-room:1:picture:1");
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  return studio;
}

/** Replace a workspace document in the running game, as an Update would. */
async function stage(page: Page, key: string, content: string) {
  await page.evaluate(
    async ({ key, content }) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      await session.update([{ key, content }]);
    },
    { key, content },
  );
}

/** The viewport point of logical cell x,y in the last canvas pane. */
async function cell(page: Page, x: number, y: number) {
  const pane = page.locator(".studio-pane").filter({ visible: true }).last();
  const box = (await pane.boundingBox())!;
  return { x: box.x + ((x + 0.5) * box.width) / 160, y: box.y + ((y + 0.5) * box.height) / 168 };
}

/**
 * Drag a figure `cells` to the right. The grip is the centre of a cell in
 * the figure's own column, in whole pixels: WebKit drops a pointer's
 * fraction, which at a zoom below 100% can land in the next column.
 */
async function drag(page: Page, figure: Locator, pane: Locator, cells: number) {
  const box = (await pane.boundingBox())!;
  const cell = box.width / 160;
  const column = Number(await figure.getAttribute("data-x"));
  const row = Number(await figure.getAttribute("data-y"));
  const x = (col: number) => Math.round(box.x + (col + 0.5) * cell);
  // Two rows above the baseline: still inside the figure, whatever the rounding.
  const y = Math.round(box.y + (row - 1.5) * (box.height / 168));
  await page.mouse.move(x(column), y);
  await page.mouse.down();
  await page.mouse.move(x(column + cells), y, { steps: 4 });
  await page.mouse.up();
}

async function lens(studio: Locator, name: "Visual" | "Priority") {
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name, exact: true })
    .click();
}

/** Select the item named exactly `name` through the Items filter. */
async function select(studio: Locator, name: string) {
  const search = studio.getByRole("searchbox", { name: "Filter items" });
  await search.fill(name);
  const row = studio
    .locator('[role="treeitem"][data-row]')
    .filter({ has: studio.page().getByText(name, { exact: true }) });
  await expect(row).toBeVisible();
  await row.click();
  await search.fill("");
}

async function views(studio: Locator, value: number) {
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await expect(slider).toBeVisible();
  await slider.evaluate((el, value) => {
    (el as HTMLInputElement).value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function side(studio: Locator, name: "Items" | "Inspector" | "Views") {
  await studio
    .getByRole("radiogroup", { name: "Side panel", exact: true })
    .getByRole("radio", { name, exact: true })
    .click();
}

test("Sierra's two layers: the Priority lens holds the control lines, the walk tools and panel @webkit-desktop", async ({
  page,
}) => {
  const studio = await picture(page);
  const lenses = studio.getByRole("radiogroup", { name: "Lens", exact: true });
  await expect(lenses.getByRole("radio")).toHaveCount(2);
  await expect(lenses.getByRole("radio", { name: "Walk" })).toHaveCount(0);
  // The view modes never offer "Priority" a second time.
  await lens(studio, "Priority");
  const view = studio.getByRole("toolbar", { name: "View", exact: true });
  await expect(view).toBeVisible();
  await expect(view.getByRole("radio", { name: "Priority", exact: true })).toHaveCount(0);
  await expect(view.getByRole("radio", { name: "Alone", exact: true })).toBeVisible();
  // Walls, gates, triggers and water share the Priority palette with the bands.
  await studio.locator('button[data-tool="line"]').click();
  const strip = studio.getByRole("radiogroup", { name: "Priority", exact: true });
  await expect(strip.getByRole("radio")).toHaveCount(16);
  for (const name of [/^Wall:/, /^Gate:/, /^Trigger:/, /^Water:/, /^Depth 4:/, /^Depth 15:/])
    await expect(strip.getByRole("radio", { name })).toBeVisible();
  // The filter offers the control lines as one choice.
  await expect(studio.getByTestId("priority-filter").locator("option")).toContainText([
    "All priority",
    "Distance bands",
    "Walls, water, triggers, gates",
  ]);
  // The walk tools ride the rail in the Priority lens, and leave with it.
  for (const tool of ["walk", "door", "edge"])
    await expect(studio.locator(`button[data-tool="${tool}"]`)).toBeVisible();
  await side(studio, "Inspector");
  await expect(studio.getByTestId("walk-panel")).toBeVisible();
  // No text names the lines on the canvas.
  await expect(studio.locator(".studio-pane text")).toHaveCount(0);
  await lens(studio, "Visual");
  await expect(studio.locator('button[data-tool="walk"]')).toHaveCount(0);
  await expect(studio.getByTestId("walk-panel")).toHaveCount(0);
});

test("a wall drawn in the Priority lens writes priority 0 and paints no art", async ({ page }) => {
  const studio = await picture(page);
  // Focus zooms the picture up, so each click lands well inside its cell.
  await page.getByTestId("workspace-focus").click();
  await lens(studio, "Priority");
  await studio.locator('button[data-tool="line"]').click();
  await studio
    .getByRole("radiogroup", { name: "Priority", exact: true })
    .getByRole("radio", { name: /^Wall:/ })
    .click();
  for (const [x, y] of [
    [20, 150],
    [100, 150],
    [100, 150],
  ] as const) {
    const p = await cell(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
  await expect(studio.locator('[role="treeitem"]').filter({ hasText: "Wall line" })).toHaveCount(1);
  const source = await workspaceDocument(page, "picture:1");
  expect(source).toMatch(/"Wall line 1" walk\nvis off\npri 0\nline 20,150 100,150\n# @end/);
});

test("the frame's context row says where new shapes draw, for every tool @webkit-desktop", async ({
  page,
}) => {
  const studio = await picture(page);
  const context = page.getByTestId("workspace-context");
  await expect(context).toBeVisible();
  // At the end the row says nothing about the draw order.
  await expect(context).not.toContainText("Drawing");
  await studio.getByRole("button", { name: "Earlier shape", exact: true }).click();
  const at = context.getByTestId("studio-insert-at");
  await expect(at).toBeVisible();
  await expect(at).toHaveText(/^Drawing before /);
  const back = context.getByRole("button", { name: "Back to the end", exact: true });
  await expect(back).toBeVisible();
  // The options bar and the status bar leave it to the context row.
  await expect(studio.getByTestId("studio-options-bar")).not.toContainText("Drawing");
  await expect(page.getByTestId("studio-status")).not.toContainText("Drawing");
  // The transport keeps its own marker.
  await expect(studio.getByTestId("scrubber-position")).toHaveText(await at.innerText());
  for (const tool of ["select", "line", "fill", "brush", "pipette", "hand"]) {
    await studio.locator(`button[data-tool="${tool}"]`).click();
    await expect(at).toHaveText(/^Drawing before /);
  }
  await back.click();
  await expect(context).not.toContainText("Drawing");
  await expect(studio.getByTestId("scrubber-position")).toHaveText(/^Drawing after /);
});

test("insert here on an Items row draws new shapes before it @webkit-desktop", async ({ page }) => {
  const studio = await picture(page);
  // Rows that stand for one item (groups have a twisty).
  const rows = studio.locator('[role="treeitem"][data-row]:not([aria-expanded])');
  const target = rows.nth(3);
  await expect(target).toBeVisible();
  const id = (await target.getAttribute("data-row"))!;
  const label = (await target.locator(".scene-list__label").innerText()).trim();
  // Select the row first: once shapes draw before it, the canvas stops at the
  // marker and the row, no longer drawn, wears no marks.
  await target.click();
  await expect(studio.locator('[data-role="selection"]').first()).toBeVisible();
  await target.getByTestId("row-insert").click();
  await expect(studio.locator('[data-role="selection"]')).toHaveCount(0);
  await target.hover();
  await expect(studio.locator('[data-role="hover"]')).toHaveCount(0);
  const context = page.getByTestId("workspace-context");
  await expect(context.getByTestId("studio-insert-at")).toHaveText(`Drawing before ${label}`);
  await expect(studio.getByTestId("scrubber-position")).toHaveText(`Drawing before ${label}`);
  // The list marks the place, and the rows drawn after it dim.
  const marker = studio.getByTestId("scene-insert-marker");
  await expect(marker).toBeVisible();
  await expect(marker).toHaveText("New shapes go here");
  const next = marker.locator("xpath=following-sibling::li[1]");
  await expect(next).toHaveAttribute("data-row", id);
  await expect(next).toHaveClass(/is-later/);
  // A rectangle drawn now lands just before that row, in the list and the source.
  await studio.locator('button[data-tool="rect"]').click();
  const from = await cell(page, 20, 130);
  const to = await cell(page, 30, 140);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect(studio.locator('[role="treeitem"][data-row="rect-1"]')).toBeVisible();
  const order = await studio
    .locator('[role="treeitem"][data-row]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-row")));
  expect(order[order.indexOf(id) - 1]).toBe("rect-1");
  const source = await workspaceDocument(page, "picture:1");
  expect(source.indexOf('# @item rect-1 "Rect 1"')).toBeLessThan(source.indexOf(`# @item ${id} `));
  await context.getByRole("button", { name: "Back to the end", exact: true }).click();
  await expect(marker).toHaveCount(0);
});

test("the Items list's Draw order button sorts the list and leaves the transport on @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  // Plain steps become one item each; three red lines in a row fold into a group.
  await stage(
    page,
    "picture:8",
    "vis 4\nline 10,10 30,10\nline 10,20 30,20\nline 10,30 30,30\nvis 1\nline 50,50 70,50\nend\n",
  );
  await open(page, "part-room:8:picture:8");
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  const order = studio.getByRole("button", { name: "Draw order", exact: true });
  const scrubber = studio.getByTestId("studio-scrubber");
  await expect(scrubber).toBeVisible();
  await expect(order).toHaveAttribute("aria-pressed", "false");
  const groups = studio.locator('[role="treeitem"][aria-expanded]');
  await expect(groups.first()).toBeVisible();
  const items = Number(
    (await studio.locator('[data-role="scene-count"]').innerText()).match(/\d+/)![0],
  );
  await order.click();
  await expect(order).toHaveAttribute("aria-pressed", "true");
  await expect(scrubber).toBeVisible();
  // Flat: one row per item, in draw order, and no groups.
  await expect(groups).toHaveCount(0);
  await expect(studio.locator('[role="treeitem"][data-row]')).toHaveCount(items);
  await order.click();
  await expect(order).toHaveAttribute("aria-pressed", "false");
  await expect(scrubber).toBeVisible();
  await expect(groups.first()).toBeVisible();
});

test("the Priority pen's slider runs Far at 4 to Near at 15; the header drops the step count", async ({
  page,
}) => {
  const studio = await catalog(page);
  await lens(studio, "Priority");
  await select(studio, "Marble bust");
  await side(studio, "Inspector");
  const pen = studio.getByRole("radiogroup", { name: "Priority pen", exact: true });
  await expect(pen).toBeVisible();
  await pen.getByRole("radio", { name: "Distance", exact: true }).click();
  const band = studio.getByRole("slider", { name: "Distance band", exact: true });
  await expect(band).toBeVisible();
  await expect(band).toHaveAttribute("min", "4");
  await expect(band).toHaveAttribute("max", "15");
  expect(await band.evaluate((input) => input.previousElementSibling?.textContent)).toBe("Far");
  expect(await band.evaluate((input) => input.nextElementSibling?.textContent)).toBe("Near");
  const subtitle = studio.getByTestId("inspector-subtitle");
  await expect(subtitle).toBeVisible();
  await expect(subtitle).not.toContainText("step");
});

test("Stand in the room gives the item its base distance and a wall along its base @webkit-desktop", async ({
  page,
}) => {
  const studio = await catalog(page);
  await select(studio, "Marble bust");
  await side(studio, "Inspector");
  const stand = studio.getByTestId("stand-in-room");
  await expect(stand).toBeVisible();
  await stand.click();
  await expect
    .poll(async () => (await workspaceDocument(page, "picture:1")).includes("# @depth base="))
    .toBe(true);
  const source = await workspaceDocument(page, "picture:1");
  const bust = source.slice(source.indexOf('"Marble bust"'));
  const block = bust.slice(0, bust.indexOf("# @end\n"));
  // One item: its depth block names the base row and the wall, then draws them.
  const base = Number(block.match(/# @depth base=(\d+) wall\n/)![1]);
  expect(Number(block.match(/\npri 0\nline \d+,(\d+) \d+,\1\n/)![1])).toBe(base);
});

test("Items rows drag to a new place in the draw order", async ({ page }) => {
  const studio = await picture(page);
  await studio.getByRole("button", { name: "Draw order", exact: true }).click();
  const rows = studio.locator('[role="treeitem"][data-row]');
  const moved = (await rows.nth(3).getAttribute("data-row"))!;
  const target = (await rows.nth(1).getAttribute("data-row"))!;
  const from = (await rows.nth(3).boundingBox())!;
  const to = (await rows.nth(1).boundingBox())!;
  // Dropped on the top half of a row, an item lands before it.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 6, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const order = await rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-row")),
      );
      return order.indexOf(target) - order.indexOf(moved);
    })
    .toBe(1);
  const source = await workspaceDocument(page, "picture:1");
  expect(source.indexOf(`# @item ${moved} `)).toBeLessThan(source.indexOf(`# @item ${target} `));
});

test("Copy position always writes position(oN, x, y) @webkit-desktop", async ({ page }) => {
  const studio = await picture(page, "part-room:8:picture:8");
  await stage(
    page,
    "logic:8",
    "if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);set.view(o0,8);assignn(v20,60);assignn(v21,140);position.v(o0,v20,v21);draw(o0);accept.input();}return;",
  );
  await views(studio, 100);
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("data-x", "60");
  await side(studio, "Views");
  const panel = studio.getByTestId("views-panel");
  const status = page.getByTestId("workspace-status");
  await panel.getByTestId("view-copy").click();
  await expect(status).toContainText("position(o0, 60, 140);");
  await expect(status).not.toContainText("position.v");
  // A dragged preview copies where it now stands.
  await drag(page, figure, studio.locator('.studio-pane[data-layer="art"]'), 10);
  await expect(figure).toHaveAttribute("data-x", "70");
  await panel.getByTestId("view-copy").click();
  await expect(status).toContainText("position(o0, 70, 140);");
});

test("views draw as in the game: no hover marks, every Set in line, a preview for an unknown spot @webkit-desktop", async ({
  page,
}) => {
  const studio = await picture(page, "part-room:8:picture:8");
  // Two placing lines for o0, and o1 drawn with no position at all.
  const logic = [
    "if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();",
    "animate.obj(o0);set.view(o0,8);",
    "if(isset(f6)){position(o0,60,140);}else{position(o0,100,120);}",
    "draw(o0);",
    "animate.obj(o1);load.view(9);set.view(o1,9);draw(o1);",
    "accept.input();}return;",
  ].join("");
  await stage(page, "logic:8", logic);
  await views(studio, 100);
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  // A conditional figure shows its first spot; a hover marks nothing.
  await expect(figure).toHaveAttribute("data-x", "60");
  await figure.hover();
  await expect(figure).toHaveCSS("outline-style", "none");
  await expect(figure).not.toHaveAttribute("title");
  // o1 has no known spot: it still draws, as a preview, and drags.
  const unknown = studio.locator('[data-object="1"]');
  await expect(unknown).toBeVisible();
  await expect(unknown).toHaveAttribute("data-preview", "true");
  const x = Number(await unknown.getAttribute("data-x"));
  await drag(page, unknown, studio.locator('.studio-pane[data-layer="art"]'), 10);
  await expect(unknown).toHaveAttribute("data-x", String(x + 10));
  expect(await workspaceDocument(page, "logic:8")).toBe(logic);
  // Every row has Set in; the conditional one lists both placing lines.
  await side(studio, "Views");
  const panel = studio.getByTestId("views-panel");
  const rows = panel.locator(".views-panel__row");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) await expect(row.getByTestId("view-set-in")).toBeVisible();
  await expect(rows.nth(1).getByTestId("view-set-in")).toHaveText("Set in LOGIC 8");
  await rows.first().getByTestId("view-set-in").click();
  const lines = page.getByTestId("view-set-in-line");
  await expect(lines).toHaveText([
    "LOGIC 8 · position(o0,60,140)",
    "LOGIC 8 · position(o0,100,120)",
  ]);
  await lines.nth(1).click();
  await expect(page.getByRole("tab", { name: /LOGIC 8/, selected: true })).toBeVisible();
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`picture editor storyboard moments at ${size.width} @webkit-desktop`, async ({ page }) => {
    const studio = await catalog(page, size);
    // Focus gives the editor the window, as a creator drawing would.
    const focus = page.getByTestId("workspace-focus");
    if (await focus.isVisible()) await focus.click();
    const shot = (name: string) =>
      page.screenshot({
        path: test.info().outputPath(`s3-${name}-${size.width}.png`),
        animations: "disabled",
      });
    // 1. Calm by default: Visual, the transport under the palette, plain item names.
    await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
    await shot("1-default");
    // 2. A selected fill: its fill point and a faint tint of its area.
    await select(studio, "Floor");
    await expect(studio.locator('[data-role="handles"]')).toBeVisible();
    await shot("2-fill");
    // 3. Drawing earlier on purpose: insert here, the marker, Back to the end.
    const row = studio.locator('[role="treeitem"][data-row]:not([aria-expanded])').nth(3);
    await row.click();
    await row.getByTestId("row-insert").click();
    await expect(studio.getByTestId("scene-insert-marker")).toBeVisible();
    await shot("3-insert");
    await page
      .getByTestId("workspace-context")
      .getByRole("button", { name: "Back to the end", exact: true })
      .click();
    // 4. Priority: the palette with the control lines, the filter, the room tools.
    await lens(studio, "Priority");
    const filter = studio.getByTestId("priority-filter");
    if (await filter.isVisible()) await filter.selectOption("controls");
    else {
      await studio.getByRole("toolbar", { name: "View", exact: true }).getByRole("button").click();
      await page
        .getByRole("menuitemradio", { name: "Walls, water, triggers, gates", exact: true })
        .click();
    }
    await shot("4-priority");
    // 5. The item's pens and Stand in the room.
    await select(studio, "Marble bust");
    await side(studio, "Inspector");
    await expect(studio.getByTestId("stand-in-room")).toBeVisible();
    await shot("5-pens");
    // 6. Details on demand.
    // In focus the frame's "Show game" chip sits over the column's foot: press the toggle itself.
    await studio
      .getByTestId("inspector-details")
      .evaluate((toggle) => (toggle as HTMLElement).click());
    await expect(studio.getByTestId("picture-meta")).toBeVisible();
    await studio.getByTestId("inspector-details-body").scrollIntoViewIfNeeded();
    await shot("6-details");
    // 7. The room's views and their list.
    await views(studio, 100);
    await expect(studio.locator('[data-object="0"]')).toBeVisible();
    await side(studio, "Views");
    await expect(studio.getByTestId("views-panel")).toBeVisible();
    await shot("7-views");
  });
}
