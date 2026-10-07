import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { configureAi, isolateStorage, waitForRoom, workspaceUpdated } from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";

/**
 * Renaming in Parts happens on the row: ⋯ › Rename or a double-click turns
 * the name into a field. Enter keeps it, Esc puts the old name back and
 * leaving a changed name keeps it.
 */
async function start(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("create-adventure-toggle").click();
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await workspaceUpdated(page);
  const parts = page.getByTestId("parts-list");
  // Phones open Parts from the top bar; wider screens show it beside the game.
  if (width <= 600) await page.getByTestId("workspace-parts").click();
  await expect(parts).toBeVisible();
  return parts;
}

function stateRow(page: Page, name: string, num: number) {
  return page
    .getByTestId("parts-list")
    .locator(".game-state > .state-row")
    .filter({ has: page.getByRole("button", { name: `${name} Flag ${num}`, exact: true }) });
}

for (const [width, height] of [
  [1440, 900],
  [1063, 815],
  [390, 844],
] as const)
  test(`Game state names rename on their row at ${width} @webkit-desktop`, async ({ page }) => {
    const parts = await start(page, width, height);
    const row = stateRow(page, "chime_done", 204);
    await row.getByLabel("Actions for chime_done", { exact: true }).click();
    const menu = page.getByRole("menu", { name: "Actions for chime_done", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Rename chime_done", exact: true }).click();
    const field = parts.getByRole("textbox", { name: "New name for chime_done", exact: true });
    await expect(field).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("chime_done");
    await expect(field).toBeInViewport();
    await expect(page.getByTestId("binding-details")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`rename-inline-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await field.fill("wind_chime");
    await field.press("Enter");
    await expect(stateRow(page, "wind_chime", 204)).toBeVisible();
    await workspaceUpdated(page);
    expect(await workspaceDocument(page, "bindings")).toContain("wind_chime");
    expect(await workspaceDocument(page, "logic:1")).toContain("wind_chime");

    // Esc puts the old name back.
    const renamed = stateRow(page, "wind_chime", 204);
    await renamed.getByRole("button", { name: "wind_chime Flag 204", exact: true }).dblclick();
    const again = parts.getByRole("textbox", { name: "New name for wind_chime", exact: true });
    await expect(again).toBeVisible();
    await expect(again).toBeFocused();
    await again.fill("not_kept");
    await again.press("Escape");
    await expect(again).toHaveCount(0);
    await expect(stateRow(page, "wind_chime", 204)).toBeVisible();
    expect(await workspaceDocument(page, "bindings")).not.toContain("not_kept");

    // Leaving a changed name keeps it.
    await stateRow(page, "wind_chime", 204)
      .getByRole("button", { name: "wind_chime Flag 204", exact: true })
      .dblclick();
    await parts
      .getByRole("textbox", { name: "New name for wind_chime", exact: true })
      .fill("bell_done");
    await parts.getByRole("heading", { name: "ROOMS", exact: true }).click();
    await expect(stateRow(page, "bell_done", 204)).toBeVisible();
    await workspaceUpdated(page);
    expect(await workspaceDocument(page, "bindings")).toContain("bell_done");

    // Built-in rows use the same menu and keep focus through its close.
    const builtin = parts.getByTestId("game-state-builtin");
    await builtin.getByText("Built-in", { exact: true }).click();
    await builtin.getByLabel("Actions for new_room", { exact: true }).click();
    const builtinMenu = page.getByRole("menu", { name: "Actions for new_room", exact: true });
    await expect(builtinMenu).toBeVisible();
    const renameBuiltin = builtinMenu.getByRole("menuitem", {
      name: "Rename new_room",
      exact: true,
    });
    await expect(renameBuiltin).toBeVisible();
    await renameBuiltin.click();
    const builtinField = builtin.getByRole("textbox", {
      name: "New name for new_room",
      exact: true,
    });
    await expect(builtinField).toBeVisible();
    await expect(builtinMenu).toBeHidden();
    await expect(builtinField).toBeFocused();
    await builtinField.fill("room_ready");
    await builtinField.press("Escape");
    await expect(builtinField).toHaveCount(0);
    await expect(
      builtin.getByRole("button", { name: "new_room Flag 5", exact: true }),
    ).toBeVisible();
    expect(await workspaceDocument(page, "bindings")).not.toContain("room_ready");
  });

test("named parts rows and rooms rename on their row @webkit-desktop", async ({ page }) => {
  const parts = await start(page, 1440, 900);
  // A named PICTURE under its room opens its field in place; Esc leaves it as it was.
  const picture = page.getByTestId("part-room:1:picture:1").locator("..");
  await picture.getByLabel("Actions for clearing_pic", { exact: true }).click();
  await picture.getByRole("button", { name: "Rename clearing_pic", exact: true }).click();
  const field = parts.getByRole("textbox", { name: "New name for clearing_pic", exact: true });
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await expect(page.getByTestId("binding-details")).toHaveCount(0);
  await field.press("Escape");
  await expect(field).toHaveCount(0);

  // A named SOUND renames on its row.
  const sound = page.getByTestId("part-sound:1").locator("..");
  await sound.getByLabel("Actions for chime_sound", { exact: true }).click();
  await sound.getByRole("button", { name: "Rename chime_sound", exact: true }).click();
  const soundField = parts.getByRole("textbox", { name: "New name for chime_sound", exact: true });
  await expect(soundField).toBeVisible();
  await expect(soundField).toBeFocused();
  await soundField.fill("bell_sound");
  await soundField.press("Enter");
  await expect(page.getByTestId("part-sound:1")).toBeVisible();
  await expect(page.getByTestId("part-sound:1")).toContainText("bell sound · SOUND 1");
  await workspaceUpdated(page);
  expect(await workspaceDocument(page, "bindings")).toContain("bell_sound");
  expect(await workspaceDocument(page, "logic:1")).toContain("load.sound(bell_sound)");

  // A taken name stays in the field with the reason.
  const death = page.getByTestId("part-sound:255").locator("..");
  await death.getByRole("button", { name: "death sound · SOUND 255" }).dblclick();
  const taken = parts.getByRole("textbox", { name: "New name for death_sound", exact: true });
  await expect(taken).toBeVisible();
  await expect(taken).toBeFocused();
  await taken.fill("bell_sound");
  await taken.press("Enter");
  await expect(taken).toBeVisible();
  await expect(parts.getByRole("alert")).toHaveText("That name is taken. Choose another.");
  await taken.press("Escape");
  await expect(taken).toHaveCount(0);

  // A room's ⋯ renames the room itself, as a double-click does.
  const room = page.getByTestId("part-room:1").locator("..");
  await expect(page.getByTestId("part-room:1")).toBeVisible();
  const title = (await page.getByTestId("part-room:1").textContent())!.split(" · ")[0]!.trim();
  await room.getByLabel(`Actions for ${title}`, { exact: true }).click();
  await room.getByRole("button", { name: `Rename ${title}`, exact: true }).click();
  const roomField = page.getByTestId("room-rename-input");
  await expect(roomField).toBeVisible();
  await expect(roomField).toBeFocused();
  await roomField.fill("Sunny meadow");
  await roomField.press("Enter");
  await expect(page.getByTestId("part-room:1")).toBeVisible();
  await expect(page.getByTestId("part-room:1")).toContainText("Sunny meadow");
});
