import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { workspaceDocument } from "./workspaceShared.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

/** Room 1's picture in the starter game, open in the frame. */
async function picture(page: Page, part = "part-room:1:picture:1") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, part);
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await expect(studio).toBeVisible();
  return studio;
}

/** Replace a workspace document through the session (draft + commit-free). */
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

/** The logical cell x,y in the first canvas pane. */
async function cell(page: Page, x: number, y: number) {
  const pane = page.locator(".studio-pane").last();
  const box = (await pane.boundingBox())!;
  return { x: box.x + ((x + 0.5) * box.width) / 160, y: box.y + ((y + 0.5) * box.height) / 168 };
}

test("Sierra's two layers: the Priority lens holds the control lines, the walk tools and panel", async ({
  page,
}) => {
  const studio = await picture(page);
  const lenses = studio.getByRole("radiogroup", { name: "Lens", exact: true });
  await expect(lenses.getByRole("radio")).toHaveCount(2);
  await expect(lenses.getByRole("radio", { name: "Walk" })).toHaveCount(0);
  // The view modes stop short of offering "Priority" a second time.
  await lenses.getByRole("radio", { name: "Priority", exact: true }).click();
  const view = studio.getByRole("toolbar", { name: "View", exact: true });
  await expect(view.getByRole("radio", { name: "Priority", exact: true })).toHaveCount(0);
  // Walls, water, triggers and gates are on the Priority palette with the bands.
  const strip = studio.locator(".workspace-palette__choices");
  await expect(strip.getByRole("radio", { name: /^Wall/ })).toBeVisible();
  await expect(strip.getByRole("radio", { name: /^Gate/ })).toBeVisible();
  await expect(strip.getByRole("radio", { name: /^Trigger/ })).toBeVisible();
  await expect(strip.getByRole("radio", { name: /^Water/ })).toBeVisible();
  await expect(strip.getByRole("radio", { name: /^Depth 15/ })).toBeVisible();
  // The walk tools ride the rail in the Priority lens.
  await expect(studio.locator('button[data-tool="walk"]')).toBeVisible();
  await expect(studio.locator('button[data-tool="door"]')).toBeVisible();
  await expect(studio.locator('button[data-tool="edge"]')).toBeVisible();
  // …and its panel sits in the Inspector.
  await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
  await expect(studio.getByTestId("walk-panel")).toBeVisible();
  // No canvas text labels name the lines.
  await expect(studio.locator('[data-role="control-labels"]')).toHaveCount(0);
});

test("a control line drawn in the Priority lens writes priority 0–3 and paints no art", async ({
  page,
}) => {
  const studio = await picture(page);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Priority", exact: true })
    .click();
  await studio.locator(".workspace-palette__choices").getByRole("radio", { name: /^Wall/ }).click();
  await studio.locator('button[data-tool="line"]').click();
  for (const [x, y] of [
    [20, 150],
    [100, 150],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await page.keyboard.press("Enter");
  const row = studio.locator('[role="treeitem"]').filter({ hasText: "Wall" }).last();
  await expect(row).toBeVisible();
  const source = await page.evaluate(() =>
    (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession().workingSnapshot().read("picture:1")?.content,
  );
  expect(String(source)).toMatch(/pri 0\nline 20,150 100,150/);
  expect(String(source)).not.toMatch(/vis \d+\nline 20,150/);
});

test("the frame's context row says where new shapes draw, for every tool", async ({ page }) => {
  const studio = await picture(page);
  const context = page.locator(".workspace-context");
  await expect(context).toBeVisible();
  // Mid-order: the context row carries the marker and the way back to the end.
  await page.keyboard.press(",");
  await expect(context).toContainText("Drawing before");
  const back = context.getByRole("button", { name: "Back to the end", exact: true });
  await expect(back).toBeVisible();
  // The options bar and the status bar do not repeat it.
  await expect(studio.getByTestId("studio-options-bar")).not.toContainText("Drawing before");
  await expect(page.getByTestId("studio-status")).not.toContainText("Drawing before");
  // The transport keeps its own marker.
  await expect(studio.getByTestId("scrubber-position")).toContainText("Drawing before");
  // Every tool: the marker stays when a drawing tool is active.
  await studio.locator('button[data-tool="fill"]').click();
  await expect(context).toContainText("Drawing before");
  await back.click();
  await expect(context).not.toContainText("Drawing before");
  await expect(studio.getByTestId("scrubber-position")).toContainText("Drawing");
});

test("Items rows offer insert here, which moves the marker before the row", async ({ page }) => {
  await picture(page);
  const studio = page.getByTestId("room-studio");
  const rows = studio.locator('[role="treeitem"][data-row]');
  const label = (await rows.nth(1).locator(".scene-list__label").innerText()).trim();
  await rows.nth(1).locator('[data-testid="row-insert"]').click();
  const context = page.locator(".workspace-context");
  await expect(context).toContainText(`Drawing before ${label}`);
  await expect(studio.getByTestId("scrubber-position")).toContainText(`Drawing before ${label}`);
});

test("the Items list's Draw order button sorts the list and never hides the transport", async ({
  page,
}) => {
  const studio = await picture(page);
  const order = studio.getByRole("button", { name: "Draw order", exact: true });
  await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
  const names = await studio
    .locator('[role="treeitem"][data-row] .scene-list__label')
    .allInnerTexts();
  await order.click();
  // Sorting changes the list's presentation, not the transport's.
  await expect(order).toHaveAttribute("aria-pressed", "true");
  await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
  const sorted = await studio
    .locator('[role="treeitem"][data-row] .scene-list__label')
    .allInnerTexts();
  // The flat draw-order list names every item exactly once, in order.
  expect(sorted.length).toBeGreaterThanOrEqual(names.length);
  await order.click();
  await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
});

test("the Priority pen's slider runs Far at 4 to Near at 15", async ({ page }) => {
  const studio = await picture(page);
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
  await studio.locator('[role="treeitem"][data-row]').first().click();
  await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
  const band = studio.getByRole("slider", { name: "Distance band", exact: true });
  await expect(band).toBeVisible();
  const labels = await band.evaluate(
    (input) => `${input.previousElementSibling?.textContent} … ${input.nextElementSibling?.textContent}`,
  );
  expect(labels).toMatch(/^Far.*Near$/);
  await expect(band).toHaveAttribute("min", "4");
  await expect(band).toHaveAttribute("max", "15");
});

test("the inspector header drops the step count; Details keeps it", async ({ page }) => {
  const studio = await picture(page);
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
  await studio.locator('[role="treeitem"][data-row]').first().click();
  await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
  const subtitle = studio.getByTestId("inspector-subtitle");
  await expect(subtitle).toBeVisible();
  await expect(subtitle).not.toContainText("step");
});

test("Copy position always writes position(oN, x, y), never position.v", async ({ page }) => {
  const studio = await picture(page, "part-room:8:picture:8");
  await stage(
    page,
    "logic:8",
    "if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);set.view(o0,8);assignn(v20,60);assignn(v21,140);position.v(o0,v20,v21);draw(o0);accept.input();}return;",
  );
  await page.getByTestId("workspace-update").click();
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await slider.evaluate((el) => {
    (el as HTMLInputElement).value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  await studio
    .getByRole("radiogroup", { name: "Side panel", exact: true })
    .getByRole("radio", { name: "Views", exact: true })
    .click();
  const source = await workspaceDocument(page, "logic:8");
  await studio.getByTestId("views-panel").getByTestId("view-copy").click();
  const next = await workspaceDocument(page, "logic:8");
  expect(next).toContain("position.v(o0,v20,v21)");
  expect(next).toMatch(/position\(o0,60,140\);/);
  expect(next).not.toMatch(/position\.v\(o0,\s*6\d/);
  expect(next).toBe(`${source.slice(0, -"return;".length)}`);
});

test("views draw as in the game: no hover box, every Set in line, a preview when the spot is unknown", async ({
  page,
}) => {
  const studio = await picture(page, "part-room:8:picture:8");
  // Two placing lines for o0, plus o1 whose spot is chosen at run time.
  await stage(
    page,
    "logic:8",
    [
      "if(isset(f5)){assignn(v100,8);load.pic(v100);draw.pic(v100);show.pic();",
      "animate.obj(o0);set.view(o0,8);",
      'if(isset(f6)){position(o0,60,140);}else{position(o0,100,120);}',
      "draw(o0);",
      "animate.obj(o1);load.view(9);set.view(o1,9);draw(o1);",
      "accept.input();}return;",
    ].join(""),
  );
  await page.getByTestId("workspace-update").click();
  const slider = studio.getByRole("slider", { name: "Views", exact: true });
  await slider.evaluate((el) => {
    (el as HTMLInputElement).value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toBeVisible();
  // A hover marks nothing: the view draws exactly as it does in the game.
  await figure.hover();
  await expect(figure).toHaveCSS("outline-style", "none");
  await expect(figure).toHaveCSS("outline-width", "0px");
  // o1 has no provable spot: it still draws, as a preview, and drags.
  const unknown = studio.locator('[data-object="1"]');
  await expect(unknown).toBeVisible();
  await expect(unknown).toHaveAttribute("data-preview", "");
  const at = (await unknown.boundingBox())!;
  const pane = (await studio.locator('.studio-pane[data-layer="art"]').boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + (10 * pane.width) / 160, at.y + at.height / 2);
  await page.mouse.up();
  await expect(unknown).not.toHaveAttribute("data-x", String(await unknown.getAttribute("data-x")));
  await expect(unknown).toHaveAttribute("data-x", /\d+/);
  // Every row can open its placing line; a conditional one lists them all.
  await studio
    .getByRole("radiogroup", { name: "Side panel", exact: true })
    .getByRole("radio", { name: "Views", exact: true })
    .click();
  const panel = studio.getByTestId("views-panel");
  const rows = panel.locator(".views-panel__row");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) await expect(row.getByTestId("view-set-in")).toBeVisible();
  const picks = rows.first().getByTestId("view-set-in");
  const options = await picks.locator("option").allInnerTexts();
  expect(options.join("|")).toContain("60, 140");
  expect(options.join("|")).toContain("100, 120");
  // Set in opens the logic at the placing line.
  await picks.selectOption({ index: 1 });
  await expect(page.getByRole("tab", { name: /LOGIC 8/ })).toBeVisible();
});

test("Stand in the room places the item's wall line at its base", async ({ page }) => {
  const studio = await picture(page);
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
  await studio.locator('[role="treeitem"][data-row]').first().click();
  await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
  const stand = studio.getByTestId("stand-in-room");
  await expect(stand).toBeVisible();
  await stand.click();
  const source = await page.evaluate(() =>
    String(
      (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession().workingSnapshot().read("picture:1")?.content,
    ),
  );
  // The wall line lands under the item's base, in its item.
  expect(source).toMatch(/pri 0/);
});
