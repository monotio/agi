import { expect, test } from "./test.ts";
import {
  configureAi,
  isolateStorage,
  textHook,
  waitForRoom,
  workspaceUpdated,
} from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";

function hasDocument(page: Page, key: string): Promise<boolean> {
  return page.evaluate((key) => {
    const probe = window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } };
    return probe.__AGI_PROJECT__.getSession().workingSnapshot().keys.includes(key);
  }, key);
}

/**
 * A Door in a one-room game can lead to a new room: "New room" in its
 * destination choice adds the next room, as Rooms + does, names it in place
 * and picks it as the destination.
 */
for (const [width, height] of [
  [1440, 900],
  [1063, 815],
  [390, 844],
] as const)
  test(`a Door's destination offers New room at ${width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await isolateStorage(page);
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await page.getByTestId("create-adventure-toggle").click();
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    await waitForRoom(page, 1);
    await workspaceUpdated(page);
    expect(await hasDocument(page, "logic:2")).toBe(false);
    if (width <= 600) {
      await page.getByTestId("workspace-parts").click();
      await page.getByTestId("part-room:1:picture:1").click();
      await page.getByTestId("room-actions-menu").click();
    } else await page.getByTestId("part-room:1:picture:1").click();
    await page.getByTestId("room-action-door").click();
    const overlay = page.getByTestId("guided-placement");
    await expect(overlay).toBeVisible();
    const box = (await overlay.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.98, box.y + box.height * 0.75, { steps: 4 });
    await page.mouse.up();
    await overlay.getByRole("button", { name: "Done", exact: true }).click();
    const form = page.getByTestId("workspace-guided-form");
    await expect(form).toBeVisible();
    const destinations = form.getByRole("group", { name: "Destination room", exact: true });
    const fresh = destinations.getByRole("button", { name: "New room", exact: true });
    await expect(fresh).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`door-new-room-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await fresh.click();
    // The new room is the destination, and the Door form stays open on Room 1.
    const picked = destinations.getByRole("button", { name: /ROOM 2/ });
    await expect(picked).toHaveAttribute("aria-pressed", "true");
    await expect(form).toBeVisible();
    expect(await hasDocument(page, "logic:2")).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`door-new-room-picked-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeHidden();
    expect(await workspaceDocument(page, "logic:1")).toContain("new.room(2)");
    expect((await textHook(page)).room).toBe(1);
    // Parts names the new room in place.
    if (width <= 600) await page.getByTestId("workspace-parts").click();
    const rename = page.getByTestId("room-rename-input");
    await expect(rename).toBeVisible();
    await rename.fill("Cave");
    await rename.press("Enter");
    await expect(page.getByTestId("part-room:2")).toContainText("Cave");
  });
