import { workspaceDocument, openWorkspaceLogic } from "./workspaceShared.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";
import type { Page } from "@playwright/test";
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
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
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
        expect(editor.x).toBeGreaterThanOrEqual(game.x + game.width);
        expect(editor.width).toBeCloseTo(game.width, 0);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: test.info().outputPath(`picture-${width}.png`) });
      await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
      await expect(studio.locator(".studio__inspector")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`inspector-${width}.png`) });
      await expect(studio.getByTestId("studio-size")).toBeVisible();
      await expect(studio.getByTestId("studio-issues")).toBeVisible();
      await expect(
        studio.locator(".studio__meta-bar").getByText("AGI 2.936", { exact: true }),
      ).toBeVisible();
      await expect(studio.getByRole("button", { name: "Share picture" })).toBeVisible();
    });
  });
}
test.describe("phone Items", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("Items rows remain visible and select an item on a phone", async ({ page }) => {
    const studio = await picture(page);
    const row = studio.locator('[role="treeitem"][data-row]').first();
    await expect(row).toBeVisible();
    await expect(row).toBeInViewport({ ratio: 1 });
    await studio.getByRole("searchbox", { name: "Filter items" }).fill("Marble bust");
    const bust = studio.locator('[role="treeitem"][data-row]').first();
    await expect(bust).toBeVisible();
    await bust.click();
    await studio.getByRole("radio", { name: "Inspector", exact: true }).click();
    await expect(studio.getByTestId("item-label")).toBeVisible();
    await expect(studio.getByTestId("item-label")).toHaveValue("Marble bust");
    await expect(studio.getByTestId("studio-status")).toBeInViewport();
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
      const studio = await picture(page);
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
      const rebuilt = studio.getByTestId("studio-source-kind");
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
test("side panel collapse widens the PICTURE canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  const studio = await picture(page);
  const before = (await studio.locator(".studio__stage").boundingBox())!.width;
  await studio.getByRole("button", { name: /Hide side panel/ }).click();
  const after = (await studio.locator(".studio__stage").boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 100);
});
test("draw order, Split and Depth bands are reachable in the workspace", async ({ page }) => {
  const studio = await picture(page);
  await studio.getByRole("button", { name: "Draw order", exact: true }).click();
  await expect(studio.getByTestId("studio-scrubber")).toBeVisible();
  await studio
    .getByTestId("studio-options-bar")
    .getByRole("radio", { name: "Depth", exact: true })
    .click();
  await studio.getByRole("radio", { name: "Split", exact: true }).click();
  await expect(studio.locator(".studio-pane")).toHaveCount(2);
  await expect(studio.getByRole("button", { name: "Depth bands", exact: true })).toBeVisible();
});
test("a line offers Done and finishes by clicking its last point", async ({ page }) => {
  const studio = await picture(page);
  await studio.locator('button[data-tool="line"]').click();
  for (const [x, y] of [
    [40, 110],
    [60, 115],
    [70, 120],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await expect(studio.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("line-done.png") });
  const p = await cell(page, 70, 120);
  await page.mouse.click(p.x, p.y);
  await expect(studio.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await workspaceUpdated(page);
});
test("a polygon offers Done and its point menu names Delete shape", async ({ page }) => {
  const studio = await picture(page);
  await studio.locator('button[data-tool="polygon"]').click();
  for (const [x, y] of [
    [40, 110],
    [70, 110],
    [70, 140],
    [40, 140],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  const done = studio.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  await done.click();
  await workspaceUpdated(page);
  await studio.locator('button[data-tool="point"]').click();
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
test("Walk shows doors and runs a real test with Play here", async ({ page }) => {
  const studio = await picture(page);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Walk", exact: true })
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
  const status = studio.locator(".studio__status");
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
  const separator = page.getByRole("separator", { name: "Editor width" });
  await expect(separator).toBeVisible();
  const before = await page.evaluate(() => ({
    stored: localStorage.getItem("monotio_agi.workspaceSplit"),
    width: document.querySelector<HTMLCanvasElement>('[data-testid="gpu-canvas"]')!.width,
  }));
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 40, { steps: 20 });
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
  await expect(studio.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await studio.getByRole("button", { name: "Done", exact: true }).click();
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
    .getByRole("radiogroup", { name: "Art colour", exact: true })
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
  const studio = await picture(page);
  for (const kind of ["still", "clip"] as const) {
    await studio.getByTestId("studio-share").click();
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
  const level = studio.locator(".studio-zoom__level");
  await expect(level).toBeVisible();
  await studio.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(level).toHaveText("100%");
  await studio.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(level).toHaveText("200%");
  const focus = page.getByTestId("workspace-focus");
  await expect(focus).toBeVisible();
  await focus.click();
  await expect(page.locator(".play-area")).toBeHidden();
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Walk", exact: true })
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
  await expect(studio.getByTestId("studio-notice")).toContainText("Door edit rejected");
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
  const notice = studio.getByTestId("studio-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("needs some width and height");
  await page.screenshot({ path: test.info().outputPath("walk-doors.png") });
});

test("Walk keeps an unfinished box number when its saved LOGIC refreshes", async ({ page }) => {
  const studio = await picture(page);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Walk", exact: true })
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
    .getByRole("radio", { name: "Depth", exact: true })
    .click();
  const value = studio
    .getByRole("radiogroup", { name: "Depth value", exact: true })
    .getByRole("radio", { name: /^Depth 8,/ });
  await expect(value).toBeVisible();
  await value.click();
  await expect(value).toHaveAttribute("aria-checked", "true");
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
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Walk", exact: true })
    .click();
  await studio.locator('button[data-tool="door"]').click();
  const from = await cell(page, 120, 130),
    to = await cell(page, 145, 150);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const notice = studio.getByTestId("studio-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Fix the room’s LOGIC before changing its doors.");
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
});

// The retired live-edit tip is replaced by the Update game count, dots and
// private stage overlay assertions in workspace-update.spec.ts.

test("drawing cannot resubmit a Walk edit over a newer pending LOGIC draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const studio = await picture(page);
  const source = "// Newer pending room text.\nreturn;\nunknown.opcode();";
  await studio
    .getByRole("radiogroup", { name: "Lens", exact: true })
    .getByRole("radio", { name: "Walk", exact: true })
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
    .getByRole("radio", { name: "Art", exact: true })
    .click();
  await studio.locator('button[data-tool="line"]').click();
  for (const [x, y] of [
    [40, 110],
    [60, 115],
  ]) {
    const p = await cell(page, x!, y!);
    await page.mouse.click(p.x, p.y);
  }
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toBe(source);
});
