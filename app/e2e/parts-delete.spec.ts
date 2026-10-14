import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { runningWorkspaceDocument } from "./workspaceShared.ts";

async function start(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-blank").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await page.getByTestId("empty-add-room").click();
  await expect(page.getByTestId("room-rename-input")).toBeVisible();
  await page.getByTestId("room-rename-input").press("Escape");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}
async function parts(page: Page): Promise<void> {
  if (!(await page.getByTestId("parts-list").isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
}
async function remove(page: Page, id: string, room = false): Promise<void> {
  await parts(page);
  await page
    .getByTestId(id)
    .locator("..")
    .getByRole("button", { name: /^Actions for / })
    .click();
  await page
    .getByRole("menuitem", { name: room ? "Delete room…" : "Delete…", exact: true })
    .click();
}
async function draftDocument(page: Page, key: string): Promise<string | null> {
  return page.evaluate((key) => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const value = session.workingSnapshot().read(key)?.content;
    return value === undefined ? null : String(value);
  }, key);
}
for (const [width, height] of [
  [1440, 900],
  [1063, 900],
  [390, 844],
] as const) {
  test.describe(`Parts delete ${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: width === 390 });
    test(`all pictures appear in their section and a used delete stays a draft${width === 390 ? " @phone" : " @webkit-desktop"}`, async ({
      page,
    }) => {
      await start(page);
      await expect(page.getByTestId("room-studio")).toBeVisible();
      await parts(page);
      await expect(page.getByTestId("part-picture:1")).toHaveText("PICTURE 1 · Room 1");
      await reviewShot(page, `parts-${width}`);
      const original = await runningWorkspaceDocument(page, "logic:1");
      const originalPicture = await runningWorkspaceDocument(page, "picture:1");
      await remove(page, "part-picture:1");
      const dialog = page.getByRole("dialog", { name: "Delete PICTURE 1", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/Used in LOGIC 1 line \d+/);
      await expect(dialog).toContainText("These will show as problems until you change them.");
      await reviewShot(page, `delete-dialog-${width}`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await draftDocument(page, "picture:1")).toBe(originalPicture);
      await remove(page, "part-room:1:picture:1");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("part-picture:1")).toHaveCount(0);
      expect(await draftDocument(page, "picture:1")).toBeNull();
      expect(await draftDocument(page, "logic:1")).toBe(original);
      expect(await runningWorkspaceDocument(page, "picture:1")).toBe(originalPicture);
      await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
      await page.getByTestId("workspace-update").click();
      const notice = page
        .getByRole("alert")
        .filter({ hasText: "LOGIC 1 has errors. Fix them to update the game." });
      await expect(notice).toHaveCount(1);
      await expect(notice).toBeVisible();
      expect(await runningWorkspaceDocument(page, "logic:1")).toBe(original);
      await notice.getByRole("button", { name: "Go to error", exact: true }).click();
      const surface = page.getByTestId("workspace-logic-editor").filter({ visible: true });
      await expect(surface.locator(".squiggly-error").first()).toBeVisible();
      const selection = () =>
        page.evaluate(async () => {
          const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
          const editor = monaco.editor.getEditors().find((entry) => entry.hasTextFocus());
          const selected = editor?.getSelection();
          return selected ? editor?.getModel()?.getValueInRange(selected) : null;
        });
      await expect.poll(selection).toBe("v50");
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
            const editor = monaco.editor.getEditors().find((entry) => entry.hasTextFocus())!;
            const model = editor.getModel()!;
            return monaco.editor
              .getModelMarkers({ resource: model.uri })
              .filter((marker) => marker.message.includes("picture:1"))
              .map((marker) => ({
                operand: model.getValueInRange(marker),
                startLineNumber: marker.startLineNumber,
                startColumn: marker.startColumn,
                endLineNumber: marker.endLineNumber,
                endColumn: marker.endColumn,
              }));
          }),
        )
        .toEqual([
          { operand: "v50", startLineNumber: 6, startColumn: 12, endLineNumber: 6, endColumn: 15 },
          { operand: "v50", startLineNumber: 7, startColumn: 12, endLineNumber: 7, endColumn: 15 },
        ]);
      await reviewShot(page, `deleted-picture-markers-${width}`);
      await parts(page);
      await page.getByTestId("part-problems").click();
      const problems = page.getByTestId("workspace-problems");
      await expect(problems).toContainText("picture:1");
      await problems.getByRole("button", { name: /picture:1.*load.pic/ }).click();
      await expect.poll(selection).toBe("v50");
      await parts(page);
      await page.getByRole("button", { name: "Add a picture", exact: true }).click();
      expect(await draftDocument(page, "picture:1")).toBe("end\n");
      await expect(page.getByTestId("workspace-status-problems")).toBeHidden();
      await page.getByTestId("workspace-update").click();
      await expect.poll(() => runningWorkspaceDocument(page, "picture:1")).toBe("end\n");
      await expect(notice).toHaveCount(0);
    });
    test(`an unused SOUND deletes immediately and Undo restores it${width === 390 ? " @phone" : " @webkit-desktop"}`, async ({
      page,
    }) => {
      await start(page);
      await parts(page);
      await page.getByRole("button", { name: "Add a sound", exact: true }).click();
      await expect.poll(() => draftDocument(page, "sound:1")).not.toBeNull();
      const before = await draftDocument(page, "sound:1");
      expect(before).not.toBeNull();
      await page.getByTestId("workspace-update-menu").click();
      await page.getByRole("menuitem", { name: "Update and keep playing", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const session = (
              window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
            ).__AGI_PROJECT__.getSession();
            const value = session.model.capture().read("sound:1")?.content;
            return value === undefined ? null : String(value);
          }),
        )
        .toBe(before);
      await remove(page, "part-sound:1");
      await expect(page.getByRole("dialog").filter({ visible: true })).toHaveCount(0);
      expect(await draftDocument(page, "sound:1")).toBeNull();
      await expect(page.getByTestId("part-sound:1")).toHaveCount(0);
      await page.getByTestId("workspace-undo").click();
      expect(await draftDocument(page, "sound:1")).toBe(before);
      await parts(page);
      await expect(page.getByTestId("part-sound:1")).toBeVisible();
    });
    test(`Tests never block game edits: room deletion offers checked test cleanup and Cancel${width === 390 ? " @phone" : " @webkit-desktop"}`, async ({
      page,
    }) => {
      await start(page);
      const tests = JSON.stringify({
        format: "monotio.agi.tests.v2",
        tests: [
          { name: "Home", room: 1, steps: [] },
          { name: "Future", room: 2, steps: [] },
        ],
      });
      await page.evaluate(async (tests) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        await session.stage([{ key: "tests", content: tests }]);
      }, tests);
      const before = await draftDocument(page, "logic:1");
      await remove(page, "part-room:1", true);
      const dialog = page.getByRole("dialog", { name: "Delete room", exact: true });
      await expect(dialog).toContainText("Delete room 1.");
      const cleanup = dialog.getByRole("checkbox", {
        name: "Also delete tests that use this room",
        exact: true,
      });
      await expect(cleanup).toBeChecked();
      await cleanup.uncheck();
      await expect(dialog).toContainText("Tests that use this room will fail when run.");
      await reviewShot(page, `delete-room-tests-${width}`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await draftDocument(page, "logic:1")).toBe(before);
      expect(await draftDocument(page, "tests")).toBe(tests);
      await remove(page, "part-room:1", true);
      await expect(cleanup).toBeChecked();
      await cleanup.uncheck();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      expect(await draftDocument(page, "logic:1")).toBeNull();
      expect(await draftDocument(page, "tests")).toBe(tests);
      await page.getByTestId("workspace-undo").click();
      expect(await draftDocument(page, "logic:1")).toBe(before);
      await remove(page, "part-room:1", true);
      await expect(cleanup).toBeChecked();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      expect(
        JSON.parse((await draftDocument(page, "tests"))!).tests.map(
          (test: { name: string }) => test.name,
        ),
      ).toEqual(["Future"]);
      await page.getByTestId("workspace-undo").click();
      expect(await draftDocument(page, "tests")).toBe(tests);
      expect(await draftDocument(page, "logic:1")).toBe(before);
    });
    test(`a reopened review stays open after an earlier native close${width === 390 ? " @phone" : " @webkit-desktop"}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 1063 ? 815 : height });
      await start(page);
      await remove(page, "part-room:1", true);
      const dialog = page.getByRole("dialog", { name: "Delete room", exact: true });
      await expect(dialog).toBeVisible();
      // WebKit can deliver the earlier close after showModal reopens the dialog.
      await dialog.evaluate((element) => element.dispatchEvent(new Event("close")));
      await expect(dialog).toBeVisible();
      await reviewShot(page, `reopened-delete-review-${width}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(await draftDocument(page, "logic:1")).not.toBeNull();
    });
    test(`Tests never block game edits: room deletion refreshes a stale tests preview${width === 390 ? " @phone" : " @webkit-desktop"}`, async ({
      page,
    }) => {
      await start(page);
      await remove(page, "part-room:1", true);
      const dialog = page.getByRole("dialog", { name: "Delete room", exact: true });
      const tests = JSON.stringify({
        format: "monotio.agi.tests.v2",
        tests: [{ name: "Late", room: 1, steps: [] }],
      });
      await page.evaluate(async (tests) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        await session.stage([{ key: "tests", content: tests }]);
      }, tests);
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog).toBeVisible();
      expect(await draftDocument(page, "logic:1")).not.toBeNull();
      expect(await draftDocument(page, "tests")).toBe(tests);
      await dialog
        .getByRole("checkbox", { name: "Also delete tests that use this room", exact: true })
        .uncheck();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(await draftDocument(page, "logic:1")).toBeNull();
      expect(await draftDocument(page, "tests")).toBe(tests);
    });
    test(`Delete room preserves code and Undo restores its Launch metadata${width === 390 ? " @phone" : " @webkit-desktop"}`, async ({
      page,
    }) => {
      await start(page);
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const world = JSON.parse(String(session.workingSnapshot().read("world")!.content));
        world.launches = { "1": { entries: [{ id: "home", name: "Home" }] } };
        await session.stage([{ key: "world", content: JSON.stringify(world) }]);
      });
      const world = await draftDocument(page, "world");
      const boot = await draftDocument(page, "logic:0");
      const logic = await draftDocument(page, "logic:1");
      await remove(page, "part-room:1", true);
      const dialog = page.getByRole("dialog", { name: "Delete room", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      expect(await draftDocument(page, "logic:1")).toBeNull();
      expect(await draftDocument(page, "logic:0")).toBe(boot);
      expect(JSON.parse((await draftDocument(page, "world"))!).launches?.["1"]).toBeUndefined();
      await expect(page.getByTestId("part-room:1")).toHaveCount(0);
      await page.getByTestId("workspace-undo").click();
      expect(await draftDocument(page, "logic:1")).toBe(logic);
      expect(await draftDocument(page, "world")).toBe(world);
    });
  });
}
