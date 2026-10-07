import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, waitForRoom, textHook } from "./engineProbe.ts";
import type { Page } from "@playwright/test";
import { findWorkspaceLogic } from "./workspaceShared.ts";

async function starterLogic(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  if (page.viewportSize()!.width <= 600 && !(await page.getByTestId("parts-list").isVisible()))
    await page.getByTestId("workspace-parts").click();
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
}
async function breakpoint(page: Page): Promise<void> {
  const editor = page.getByTestId("workspace-logic-editor");
  await findWorkspaceLogic(page, "assignn(v50, clearing_pic)");
  await page.keyboard.press("F9");
  await expect(editor.locator(".workspace-breakpoint")).toHaveCount(1);
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`one run control pauses at an armed breakpoint at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await starterLogic(page);
    const context = page.getByTestId("workspace-context");
    await expect(context.getByRole("button", { name: /^(?:▶ )?Play |^Debug / })).toHaveCount(0);
    await expect(context.getByRole("group", { name: "Debug controls" })).toHaveCount(0);
    await expect(page.getByTestId("workspace-update")).toHaveText("");
    await reviewShot(page, `run-logic-${width}`);
    await breakpoint(page);
    await page.getByTestId("workspace-update").click();
    await expect(page.getByTestId("workspace-debug-status")).toHaveText(
      "Paused at first_room · LOGIC 1, line 3",
    );
    await expect(context.getByTestId("debug-stop")).toBeVisible();
    await expect(page.locator(".workspace-stopped-line").first()).toBeVisible();
    await reviewShot(page, `run-paused-${width}`);
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await expect(page.getByRole("option", { name: /^Continue F5$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+F5");
    await expect(context.getByRole("group", { name: "Debug controls" })).toHaveCount(0);
  });
}

test("F5 uses the top action; disabling breakpoints persists and passes them @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starterLogic(page);
  await breakpoint(page);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  const label = await page.getByTestId("workspace-update").getAttribute("aria-label");
  await expect(page.getByRole("option", { name: `${label} F5`, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("workspace-debug-status")).toHaveText(
    "Paused at first_room · LOGIC 1, line 3",
  );
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitemcheckbox", { name: "Disable breakpoints", exact: true }).click();
  await page.getByTestId("workspace-update").click();
  const before = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(before);
  await expect(page.getByTestId("workspace-debug-status")).toHaveCount(0);
  await page.reload();
  await waitForRoom(page, 1);
  await page.getByTestId("workspace-update-menu").click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Disable breakpoints", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByTestId("part-room:1:logic").click();
  await expect(
    page.getByTestId("workspace-logic-editor").locator(".workspace-breakpoint"),
  ).toHaveCount(1);
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitemcheckbox", { name: "Disable breakpoints", exact: true }).click();
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("workspace-debug-status")).toHaveText(
    "Paused at first_room · LOGIC 1, line 3",
  );
  await page.getByTestId("part-debug:breakpoints").click();
  await page.getByRole("switch", { name: "Disable breakpoints", exact: true }).check();
  await expect(
    page.getByRole("switch", { name: "Disable breakpoints", exact: true }),
  ).toBeChecked();
});

test("Update and every built-in Launch keep breakpoints on the replacement run @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starterLogic(page);
  await breakpoint(page);
  async function runTop(): Promise<void> {
    await page.evaluate(() => {
      const host = window as unknown as {
        __AGI_PROJECT__: { getWorker(): Worker };
        stoppedEpoch: number;
      };
      host.stoppedEpoch = 0;
      const worker = host.__AGI_PROJECT__.getWorker();
      const stopped = (event: MessageEvent) => {
        if (event.data.type !== "debugStopped") return;
        worker.removeEventListener("message", stopped);
        if (event.data.reasons.some((reason: { kind: string }) => reason.kind === "breakpoint"))
          host.stoppedEpoch = event.data.epoch;
      };
      worker.addEventListener("message", stopped);
    });
    await page.getByTestId("workspace-update").click();
    await expect(page.getByTestId("workspace-update")).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { stoppedEpoch: number }).stoppedEpoch))
      .toBeGreaterThan(0);
    await expect(page.getByTestId("workspace-debug-status")).toHaveText(
      "Paused at first_room · LOGIC 1, line 3",
    );
  }
  await runTop();
  const source = await page.evaluate(
    () =>
      (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): { model: { capture(): { read(key: string): { content: string } } } };
          };
        }
      ).__AGI_PROJECT__
        .getSession()
        .model.capture()
        .read("logic:1").content,
  );
  await page.getByTestId("workspace-logic-editor").locator("textarea.inputarea").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(source.replace("set.horizon(74)", "set.horizon(75)"));
  await expect(page.getByTestId("workspace-update")).toHaveAccessibleName(
    "Update and restart Meadow",
  );
  await runTop();
  await expect(page.getByRole("button", { name: "Show running source", exact: true })).toHaveCount(
    0,
  );
  for (const choice of ["From the beginning", "From my game", "Carry over"]) {
    await page.getByTestId("workspace-update-menu").click();
    await page.getByRole("menuitem", { name: choice, exact: true }).click();
    if (choice === "From my game") {
      await page.getByTestId("workspace-logic-editor").locator("textarea.inputarea").focus();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(source.replace("set.horizon(74)", "set.horizon(76)"));
      await expect(page.getByTestId("workspace-update")).toHaveAccessibleName(
        "Update and return to my game",
      );
    }
    await runTop();
  }
});
