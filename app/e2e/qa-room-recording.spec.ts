import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import {
  isolateStorage,
  textHook,
  openWorkspaceAgent,
  playFromCreate,
  enterCreateMode,
} from "./engineProbe.ts";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("workspace-agent")).toBeEnabled();
}
async function record(page: Page): Promise<void> {
  await openWorkspaceAgent(page);
  if (!(await page.getByTestId("btn-record-test").isVisible()))
    await page
      .getByTestId("workspace-agent-panel")
      .getByRole("button", { name: "Agent settings", exact: true })
      .click();
  await page.getByTestId("btn-record-test").click();
  await expect(page.getByTestId("recording-bar")).toBeVisible();
}
async function stop(page: Page): Promise<void> {
  await page.getByTestId("record-stop").click();
  await expect(page.getByTestId("record-dialog")).toBeVisible();
}
async function deleteRoom(page: Page): Promise<void> {
  if (!(await page.getByTestId("parts-list").isVisible()))
    await page.getByTestId("workspace-parts").click();
  await page
    .getByTestId("part-room:3")
    .locator("..")
    .getByRole("button", { name: /^Actions for / })
    .click();
  await page.getByRole("menuitem", { name: "Delete room…", exact: true }).click();
}
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env["AGI_QA_SHOTS"];
  if (folder) await page.screenshot({ path: `${folder}/${name}.png` });
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`deleting the current room reports a beginning and leaves removed progress behind ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await starter(page);
    const roomOneSource = await page.evaluate(async (width) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const world = JSON.parse(String(session.workingSnapshot().read("world")!.content));
      world.rooms["1"] = {
        ...world.rooms["1"],
        title: "Meadow",
        description: "A meadow.",
        exits: {},
      };
      world.rooms["3"] = { title: "Lake", description: "A lake.", exits: {} };
      const source = String(session.workingSnapshot().read("logic:1")!.content);
      await session.stage([
        ...(width === 1440
          ? [{ key: "logic:1", content: 'if (said("look")) { new.room(3); }\n' + source }]
          : []),
        { key: "logic:3", content: "return;" },
        { key: "world", content: JSON.stringify(world) },
      ]);
      return source;
    }, width);
    await page.getByTestId("workspace-update").click();
    await expect(page.getByTestId("workspace-pending")).toBeHidden();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    if (!(await page.getByTestId("parts-list").isVisible()))
      await page.getByTestId("workspace-parts").click();
    await page.getByTestId("part-room:3").click();
    await expect(page.getByTestId("workspace-update")).toContainText("Lake");
    await page.getByTestId("workspace-update").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(3);
    if (width === 1440) {
      // Capture a genuine Play return point inside Lake before opening Create.
      await playFromCreate(page);
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).room).toBe(3);
      await enterCreateMode(page);
    }
    await record(page);
    await stop(page);
    await page.getByTestId("record-name").fill("Lake visit");
    await page.getByTestId("record-save").click();
    await expect(page.getByTestId("record-dialog")).toBeHidden();
    await expect(page.getByTestId("workspace-update")).toBeEnabled();
    if (width === 1440) {
      if (!(await page.getByTestId("parts-list").isVisible()))
        await page.getByTestId("workspace-parts").click();
      await page.getByTestId("part-room:1:picture:1").click();
      await expect.poll(async () => (await textHook(page)).room).toBe(3);
    }
    await page.getByTestId("workspace-update-menu").click();
    await page
      .getByRole("menuitem", {
        name: width === 1440 ? "From my game" : "Carry over",
        exact: true,
      })
      .click();
    await deleteRoom(page);
    const dialog = page.getByRole("dialog", { name: "Delete room", exact: true });
    await expect(dialog).toBeVisible();
    await shot(page, `delete-dialog-${width}`);
    await expect.soft(dialog).toContainText("Delete Lake?");
    await expect
      .soft(dialog.getByRole("checkbox", { name: /Also delete tests/ }))
      .toHaveAccessibleName("Also delete tests that use this room (1 test)");
    if (width === 390) await dialog.getByRole("checkbox", { name: /Also delete tests/ }).uncheck();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    if (width === 1440) {
      // Remove the doorway too, so only the deleted return point is at issue.
      await page.evaluate(async (source) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        await session.stage([{ key: "logic:1", content: source }]);
      }, roomOneSource);
    }
    if (width !== 390) await expect(page.getByTestId("record-result")).toBeHidden();
    await shot(page, `restart-label-${width}`);
    await expect(page.getByTestId("workspace-update")).toHaveText(
      "Update and restart · From the beginning",
    );
    await page.getByTestId("workspace-update").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await expect(page.getByTestId("workspace-pending")).toBeHidden();
    await expect
      .soft(page.getByTestId("workspace-updated"))
      .toContainText("Updated · started from beginning");
    await expect(
      page.getByRole("alert").filter({ hasText: /needs a LOGIC|Choose Restart/ }),
    ).toHaveCount(0);
  });
}

test("an empty test name returns focus to Name", async ({ page }) => {
  await starter(page);
  await record(page);
  await stop(page);
  await page.getByTestId("record-save").click();
  await expect(page.getByTestId("record-dialog")).toContainText("Name the test before saving it.");
  await expect(page.getByTestId("record-name")).toBeFocused();
});

test("game test save confirmations use plain copy and clear after eight seconds", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__AGI_NOTICE_MS__ = 8000;
  });
  await starter(page);
  await record(page);
  await stop(page);
  await page.getByTestId("record-name").fill("Meadow visit");
  await page.getByTestId("record-save").click();
  const notice = page.getByTestId("record-result");
  await expect.soft(notice).toContainText("1 game test saved");
  await page.mouse.move(0, 0);
  await expect(notice).toBeHidden({ timeout: 10_000 });
});

test("a fresh-room notice uses the room's name", async ({ page }) => {
  await starter(page);
  await playFromCreate(page);
  await enterCreateMode(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const world = JSON.parse(String(session.workingSnapshot().read("world")!.content));
    world.rooms["1"] = { title: "Meadow", description: "A meadow.", exits: {} };
    await session.stage([
      { key: "world", content: JSON.stringify(world) },
      { key: "picture:1", content: "vis 3\nfill 0,0\nend\n" },
    ]);
  });
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  await playFromCreate(page);
  await expect(page.getByTestId("return-note")).toHaveText(
    "Meadow started fresh with your changes.",
  );
});

test("a room's launch choice can switch back from beginning and survives reload", async ({
  page,
}) => {
  await starter(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const world = JSON.parse(String(session.workingSnapshot().read("world")!.content));
    world.rooms["3"] = { title: "Lake", description: "A lake.", exits: {} };
    await session.stage([
      { key: "logic:3", content: "return;" },
      { key: "world", content: JSON.stringify(world) },
    ]);
  });
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("workspace-pending")).toBeHidden();
  await page.getByTestId("part-room:3").click();
  const choose = async (name: string) => {
    await page.getByTestId("workspace-update-menu").click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await choose("From the beginning");
  await expect.soft(page.getByTestId("workspace-update")).toHaveText("From the beginning");
  await choose("Carry over");
  await expect(page.getByTestId("workspace-update")).toContainText("Lake");
  await choose("From the beginning");
  await page.reload();
  await expect(page.getByTestId("workspace-update")).toBeEnabled();
  await page.getByTestId("part-room:3").click();
  await expect(page.getByTestId("workspace-update")).toHaveText("From the beginning");
  await choose("Carry over");
  await expect(page.getByTestId("workspace-update")).toContainText("Lake");
  await page.reload();
  await expect(page.getByTestId("workspace-update")).toBeEnabled();
  await page.getByTestId("part-room:3").click();
  await expect(page.getByTestId("workspace-update")).toContainText("Lake");
});
