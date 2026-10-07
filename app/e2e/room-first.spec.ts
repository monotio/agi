import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { isolateStorage, textHook, workspaceSaved, workspaceUpdated } from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";

/** The room-first journey: a blank game grows rooms, names and a door with no forms. */
async function blankGame(page: Page, title: string): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill(title);
  await page.getByTestId("local-create-kind-blank").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(
    page.locator(".screen").getByText("Nothing to play yet.", { exact: true }),
  ).toBeVisible();
}

async function firstRoom(page: Page, name: string): Promise<void> {
  await page.getByTestId("empty-add-room").click();
  const rename = page.getByTestId("room-rename-input");
  await expect(rename).toBeVisible();
  await expect(rename).toHaveValue("Room 1");
  // Focusing selects the name, so typing replaces it.
  await rename.focus();
  await expect
    .poll(() =>
      rename.evaluate((el) => [
        (el as HTMLInputElement).selectionStart,
        (el as HTMLInputElement).selectionEnd,
      ]),
    )
    .toEqual([0, 6]);
  await rename.fill(name);
  await rename.press("Enter");
  await expect(page.getByTestId("part-room:1")).toBeVisible();
  await expect(page.getByTestId("part-room:1")).toContainText(name);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

test.describe("touch room naming", () => {
  test.use({ hasTouch: true });

  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`opening a room picture keeps the name selected at ${width} @webkit-desktop`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await blankGame(page, "Typing room names");
      await page.getByTestId("empty-add-room").click();
      const rename = page.getByTestId("room-rename-input");
      await expect(rename).toBeVisible();
      await expect(page.getByTestId("room-studio")).toBeVisible();
      await expect(rename).toBeFocused();
      expect(
        await rename.evaluate((input) => [
          (input as HTMLInputElement).selectionStart,
          (input as HTMLInputElement).selectionEnd,
        ]),
      ).toEqual([0, 6]);
      await page.keyboard.type("Meadow");
      await expect(rename).toBeFocused();
      await expect(rename).toHaveValue("Meadow");
      await page.keyboard.press("Enter");
      const room = page.getByTestId("part-room:1");
      await expect(room).toBeVisible();
      await expect(room).toContainText("Meadow");
      // Esc keeps the fresh room's default name.
      await page.getByRole("button", { name: "Add a room", exact: true }).click();
      await expect(rename).toBeVisible();
      await expect(
        page.getByRole("region", { name: "PICTURE: PICTURE 2", exact: true }),
      ).toBeVisible();
      await expect(rename).toBeFocused();
      await page.keyboard.type("Garden");
      await page.keyboard.press("Escape");
      const second = page.getByTestId("part-room:2");
      await expect(second).toBeVisible();
      await expect(second).toContainText("Room 2");
      await expect(room).toBeVisible();
      await expect(room).toContainText("Meadow");
    });

    test(`leaving a fresh room name commits it before the next edit at ${width} @webkit-desktop`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await blankGame(page, "Room names");
      await firstRoom(page, "Meadow");
      await workspaceUpdated(page);
      await page.getByRole("button", { name: "Add a room", exact: true }).click();
      const rename = page.getByTestId("room-rename-input");
      await expect(rename).toBeVisible();
      // Opening the editor can move focus before any typing.
      await rename.evaluate((input) => (input as HTMLInputElement).blur());
      await expect(rename).toBeVisible();
      await expect(rename).toHaveValue("Room 2");
      await rename.fill("Garden");
      // Tapping another part closes the keyboard and keeps the name just typed.
      const picture = page.getByTestId("part-room:1:picture:1");
      await expect(picture).toBeVisible();
      await picture.tap();
      const parts = page.getByTestId("parts-list");
      if (width <= 600 && !(await parts.isVisible()))
        await page.getByTestId("workspace-parts").click();
      await expect(parts).toBeVisible();
      await workspaceSaved(page);
      await test.info().attach(`room-name-${width}`, {
        body: await page.screenshot({
          path: test.info().outputPath(`room-name-${width}.png`),
          animations: "disabled",
          scale: "css",
        }),
        contentType: "image/png",
      });
      const world = JSON.parse(await workspaceDocument(page, "world")) as {
        rooms: Record<string, { title: string }>;
      };
      expect(world.rooms["2"]?.title).toBe("Garden");
      const room = page.getByTestId("part-room:2");
      await expect(room).toBeVisible();
      await expect(room).toContainText("Garden");
      await page.getByRole("button", { name: "Add a room", exact: true }).click();
      await expect(rename).toBeVisible();
      await expect(rename).toHaveValue("Room 3");
      await rename.fill("Forest");
      // Finishing an IME word keeps naming open; Enter itself then commits the name.
      await rename.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      await expect(rename).toBeVisible();
      await expect(rename).toHaveValue("Forest");
      await rename.dispatchEvent("keydown", { key: "Enter" });
      const third = page.getByTestId("part-room:3");
      await expect(third).toBeVisible();
      await expect(third).toContainText("Forest");
      await expect(room).toBeVisible();
      await expect(room).toContainText("Garden");
      await workspaceUpdated(page);
      await page.reload();
      if (width <= 600 && !(await parts.isVisible()))
        await page.getByTestId("workspace-parts").click();
      await expect(room).toBeVisible();
      await expect(room).toContainText("Garden");
      await expect(third).toBeVisible();
      await expect(third).toContainText("Forest");
    });
  }
});

test("blank game to Meadow, Room 2, a door drawn on the game and Play Room 2 @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await blankGame(page, "Room first");
  await page.screenshot({
    path: test.info().outputPath("1440-blank-stage.png"),
    animations: "disabled",
  });
  await firstRoom(page, "Meadow");
  await page.screenshot({
    path: test.info().outputPath("1440-meadow-named.png"),
    animations: "disabled",
  });
  // Its blank white PICTURE opened at once, filed under the room.
  const studio = page.getByRole("region", { name: "PICTURE: PICTURE 1", exact: true });
  await expect(studio).toBeVisible();
  expect(await workspaceDocument(page, "bindings")).toBe("{}"); // Game state stays empty
  // Draw on the picture.
  await studio.locator('button[data-tool="line"]').click();
  const pane = (await studio.locator(".studio-pane").last().boundingBox())!;
  for (const [x, y] of [
    [30, 120],
    [80, 150],
  ])
    await page.mouse.click(pane.x + (x! * pane.width) / 160, pane.y + (y! * pane.height) / 168);
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await workspaceUpdated(page);
  await page.screenshot({
    path: test.info().outputPath("1440-meadow-drawn.png"),
    animations: "disabled",
  });
  // + adds Room 2 at once: named in place, its PICTURE opens, the game stays.
  await page.getByRole("button", { name: "Add a room", exact: true }).click();
  const rename2 = page.getByTestId("room-rename-input");
  await expect(rename2).toBeVisible();
  await expect(rename2).toHaveValue("Room 2");
  await rename2.press("Enter");
  await expect(page.getByTestId("part-room:2")).toContainText("Room 2");
  await expect(page.getByRole("region", { name: "PICTURE: PICTURE 2", exact: true })).toBeVisible();
  expect((await textHook(page)).room).toBe(1);
  // The new PICTURE counts as the room's before Update.
  await expect(page.getByTestId("workspace-unused")).toHaveCount(0);
  // A door drawn on the game, from Meadow to Room 2.
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByRole("region", { name: "PICTURE: PICTURE 1", exact: true })).toBeVisible();
  await workspaceSaved(page);
  await page.getByTestId("room-action-door").click();
  const overlay = page.getByTestId("guided-placement");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Drag a box where the hero leaves");
  await page.screenshot({
    path: test.info().outputPath("1440-door-draw.png"),
    animations: "disabled",
  });
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.98, box.y + box.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await overlay.getByRole("button", { name: "Done", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form
    .getByRole("group", { name: "Destination room", exact: true })
    .getByRole("button", { name: /Room 2/ })
    .click();
  // The code stays behind Show code.
  await expect(form.getByTestId("guided-code-preview")).toBeHidden();
  await form.getByText("Show code", { exact: true }).click();
  await expect(form.getByTestId("guided-code-preview")).toContainText("new.room(2)");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeHidden();
  expect(await workspaceDocument(page, "logic:1")).toContain("new.room(2)");
  expect((await textHook(page)).room).toBe(1); // the game stays in Meadow
  // A right-click on the game offers the same room actions.
  const gpu = page.getByTestId("gpu-canvas");
  if (await gpu.isVisible()) {
    const at = (await gpu.boundingBox())!;
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2, { button: "right" });
    const menu = page.getByTestId("game-room-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Door", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
  // Update publishes the work; then the action button offers Play Room 2.
  const action = page.getByTestId("workspace-update");
  await expect(action).toHaveText("Update and restart Meadow");
  await action.click();
  await workspaceUpdated(page);
  await page.getByTestId("part-room:2:picture:2").click();
  await expect(action).toHaveText("Play Room 2");
  await page.screenshot({
    path: test.info().outputPath("1440-play-room-2.png"),
    animations: "disabled",
  });
  await action.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`a blank game's WORDS + adds the first room and opens WORDS at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await blankGame(page, `Blank parts ${width}`);
    const parts = page.getByTestId("parts-list");
    // The phone frame keeps the parts list behind Parts, as in a game with rooms.
    if (width <= 600) {
      await expect(parts).toBeHidden();
      await page.getByTestId("workspace-parts").click();
    }
    await expect(parts).toBeVisible();
    await parts.getByRole("button", { name: "Add a word", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await expect(page.getByRole("tab", { name: "WORDS", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-words-editor")).toBeVisible();
  });
}

for (const [width, height] of [
  [1063, 815],
  [390, 844],
] as const) {
  test(`room-first layout at ${width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await blankGame(page, `Room first ${width}`);
    await page.screenshot({
      path: test.info().outputPath(`${width}-blank-stage.png`),
      animations: "disabled",
      scale: "css",
    });
    await firstRoom(page, "Meadow");
    const studio = page.getByRole("region", { name: "PICTURE: PICTURE 1", exact: true });
    await expect(studio).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`${width}-meadow.png`),
      animations: "disabled",
      scale: "css",
    });
    // + adds Room 2; naming in place stays visible, also on the phone.
    await page.getByRole("button", { name: "Add a room", exact: true }).click();
    await expect(page.getByTestId("room-rename-input")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`${width}-room-2-named.png`),
      animations: "disabled",
      scale: "css",
    });
  });
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`Game state keeps game names flat and reserved slots folded at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    const parts = page.getByTestId("parts-list");
    if (width <= 600 && !(await parts.isVisible()))
      await page.getByTestId("workspace-parts").click();
    await expect(parts).toBeVisible();
    await workspaceSaved(page);
    await page.screenshot({
      path: test.info().outputPath(`state-parts-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    const initialGroup = parts.getByTestId("game-state-builtin");
    await expect(initialGroup).toBeVisible();
    await initialGroup.locator(":scope > summary").click();
    await page.screenshot({
      path: test.info().outputPath(`state-parts-open-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await initialGroup.locator(":scope > summary").click();
    await parts.getByTestId("part-state").click();
    const tab = page.getByTestId("workspace-state");
    await expect(tab).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`state-tab-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    const gameRow = tab.locator(":scope > table tr").filter({ hasText: "chime_done" });
    await expect(gameRow).toBeVisible();
    await expect(gameRow).toContainText("f204");
    const builtIn = tab.getByTestId("state-builtin");
    await expect(builtIn).toBeVisible();
    await expect(builtIn).not.toHaveAttribute("open");
    await builtIn.locator(":scope > summary").click();
    const reserved = builtIn.locator("tr").filter({ hasText: "current_room" });
    await expect(reserved).toBeVisible();
    await expect(reserved).toContainText("v0");
    await page.screenshot({
      path: test.info().outputPath(`state-tab-open-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    const expectedNames = [
      "system_flag_0",
      "system_flag_1",
      "system_flag_2",
      "system_flag_3",
      "system_flag_4",
      "new_room",
      "restarted",
      "system_flag_7",
      "system_flag_8",
      "sound_on",
      "trace_on",
      "system_flag_11",
      "system_flag_12",
      "system_flag_13",
      "menus_on",
      "system_flag_15",
      "current_room",
      "prev_room",
      "ego_edge",
      "score",
      "object_event_4",
      "object_event_5",
      "ego_direction",
      "system_var_7",
      "system_var_8",
      "parser_status",
      "cycle_speed",
      "system_var_11",
      "system_var_12",
      "system_var_13",
      "system_var_14",
      "system_var_15",
      "ego_view_num",
      "system_var_17",
      "system_var_18",
      "key_pressed",
      "system_var_20",
      "system_var_21",
      "system_var_22",
      "system_var_23",
      "system_var_24",
      "selected_item",
      "system_var_26",
    ];
    const rows = builtIn.locator("tr");
    await expect(rows).toHaveCount(43);
    for (const row of await rows.all()) await expect(row).toBeVisible();
    expect(await rows.locator("td:first-child > span:first-child").allTextContents()).toEqual(
      expectedNames,
    );
    await expect(reserved).toContainText("The room the player is in.");
    await expect(reserved).toContainText("Used: LOGIC");
    await expect(rows.last()).toContainText("Reserved by the interpreter.");
    await expect(builtIn.getByRole("button", { name: /^Add/ })).toHaveCount(0);
    await expect(builtIn).not.toContainText("chime_done");
    if (width <= 600 && !(await parts.isVisible()))
      await page.getByTestId("workspace-parts").click();
    await expect(parts).toBeVisible();
    const flag = parts
      .locator(".game-state > .state-row")
      .getByRole("button", { name: "chime_done Flag 204", exact: true });
    await expect(flag).toBeVisible();
    const group = parts.getByTestId("game-state-builtin");
    await expect(group).toBeVisible();
    await expect(group).not.toHaveAttribute("open");
    await group.locator(":scope > summary").click();
    await expect(
      group.getByRole("button", { name: "current_room Variable 0", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`state-parts-tab-open-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    const partRows = group.locator(":scope > .state-row");
    await expect(partRows).toHaveCount(43);
    for (const row of await partRows.all()) await expect(row).toBeVisible();
    expect(await partRows.locator("button.part > span").allTextContents()).toEqual(expectedNames);
    await expect(partRows.filter({ hasText: "current_room" })).toContainText(
      "The room the player is in.",
    );
    await expect(partRows.filter({ hasText: "current_room" })).toContainText("Used: LOGIC");
    await expect(partRows.last()).toContainText("Reserved by the interpreter.");
    await expect(group.getByRole("button", { name: /^Add/ })).toHaveCount(0);
    await expect(group).not.toContainText("chime_done");
  });
}
