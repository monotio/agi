import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerQueryFn } from "../src/worker/workerProtocol.ts";
import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { textHook, screenText, workspaceSaved } from "./engineProbe.ts";
import { focusWorkspaceLogic, runningWorkspaceDocument } from "./workspaceShared.ts";

async function launchShot(page: Page, name: string, browserName: string): Promise<void> {
  const shot = await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  if (process.env["CI"] && browserName === "webkit" && page.viewportSize()!.width === 390)
    console.log(`LAUNCH_SHOT:${name}:${shot.toString("base64")}`);
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`Launch actions ${width}`, () => {
    test.use({ hasTouch: width === 390 });
    test("selection stays in the editor and the action names its room @webkit-desktop", async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height });
      await start(page);
      await workspaceSaved(page);
      await open(page, "part-room:1:logic");
      await focusWorkspaceLogic(page);
      const action = page.getByTestId("workspace-update");
      await expect(action).toBeVisible();
      await expect(action).toHaveText("Restart Home");
      await launchShot(page, `restart-${width}`, browserName);
      await open(page, "part-room:8:logic");
      await expect(
        page.getByTestId("workspace-logic-editor").filter({ visible: true }),
      ).toBeVisible();
      expect((await textHook(page)).room).toBe(1);
      await expect(action).toHaveText("Play Garden");
      await launchShot(page, `play-${width}`, browserName);
      const source = await runningWorkspaceDocument(page, "logic:8");
      await focusWorkspaceLogic(page);
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(
        source.replace("accept.input();", 'accept.input(); print("Launch updated");'),
      );
      await page.keyboard.press("Escape");
      await workspaceSaved(page);
      await expect(action).toHaveText("Update and restart Garden");
      const modes = page.getByRole("radiogroup", { name: "Mode", exact: true });
      await expect(modes).toBeVisible();
      const bounds = await modes.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await launchShot(page, `update-${width}`, browserName);
      await action.click();
      await expect.poll(() => screenText(page)).toContain("Launch updated");
      await expect(page.getByTestId("workspace-updated")).toBeVisible();
      await expect(page.getByTestId("workspace-updated")).toContainText(
        "Updated · Garden restarted",
      );
      await page.getByTestId("workspace-update-menu").click();
      await expect(page.getByRole("menuitem", { name: "Carry over", exact: false })).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "From the beginning", exact: false }),
      ).toBeVisible();
      await launchShot(page, `menu-${width}`, browserName);
      await page.getByRole("menuitem", { name: "From the beginning", exact: false }).click();
      await expect(page.getByRole("menu")).toBeHidden();
      await expect(action).toHaveText("Play from beginning");
      expect((await textHook(page)).room).toBe(8);
      await open(page, "part-room:1:logic");
      await expect(action).toHaveText("Play Home");
      await open(page, "part-room:8:logic");
      await expect(action).toHaveText("Play from beginning");
    });
  });
}

test("Update result names the launched room after another editor opens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const onmessage = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage")!;
    let held: (() => void) | null = null;
    const hooks = window as unknown as {
      holdLaunchUpdate: boolean;
      launchUpdateHeld(): boolean;
      releaseLaunchUpdate(): void;
    };
    hooks.holdLaunchUpdate = false;
    hooks.launchUpdateHeld = () => held !== null;
    hooks.releaseLaunchUpdate = () => {
      const reply = held;
      held = null;
      reply?.();
    };
    Object.defineProperty(Worker.prototype, "onmessage", {
      configurable: true,
      get: onmessage.get!,
      set(this: Worker, listener: (event: MessageEvent) => void) {
        onmessage.set!.call(this, (event: MessageEvent) => {
          if (hooks.holdLaunchUpdate && event.data?.type === "previewUpdateResult") {
            hooks.holdLaunchUpdate = false;
            held = () => listener.call(this, event);
          } else listener.call(this, event);
        });
      },
    });
  });
  await start(page);
  await open(page, "part-room:1:logic");
  const source = await runningWorkspaceDocument(page, "logic:1");
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(`${source}\n// A room update`);
  await page.keyboard.press("Escape");
  await workspaceSaved(page);
  await page.evaluate(() => {
    (window as unknown as { holdLaunchUpdate: boolean }).holdLaunchUpdate = true;
  });
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await action.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { launchUpdateHeld(): boolean }).launchUpdateHeld(),
      ),
    )
    .toBe(true);
  await open(page, "part-room:8:logic");
  await page.evaluate(() =>
    (window as unknown as { releaseLaunchUpdate(): void }).releaseLaunchUpdate(),
  );
  const result = page.getByTestId("workspace-updated");
  await expect(result).toBeVisible();
  await expect(result).toContainText("Updated · Home restarted");
  expect((await textHook(page)).room).toBe(1);
  await expect(action).toHaveText("Play Garden");
});

test("F5 in room LOGIC debugs the selected Launch before its first instruction @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const world = JSON.parse(String(capture.read("world")!.content));
    const result = await session.submit({
      proposal: session.model.propose(capture, "Entry with a key", [
        {
          key: "world",
          content: JSON.stringify({
            ...world,
            launches: {
              "8": {
                entries: [
                  {
                    id: "key",
                    name: "With the key",
                    flags: { "77": true },
                    variables: { "90": 123 },
                    cameFrom: { room: 7, edge: 4 },
                    seed: 58235,
                  },
                ],
              },
            },
          }),
        },
      ]),
      label: "Entry with a key",
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "committed") throw new Error(result.status);
  });
  await open(page, "part-room:8:logic");
  await page.getByTestId("workspace-update-menu").click();
  const choice = page.getByRole("menuitem", { name: "With the key", exact: true });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(page.getByRole("menu")).toBeHidden();
  expect((await textHook(page)).room).toBe(1);
  await focusWorkspaceLogic(page);
  await page.keyboard.press("F5");
  const status = page.getByTestId("workspace-debug-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Paused at LOGIC 0");
  await expect(page.locator(".workspace-stopped-line").first()).toBeVisible();
  const state = await page.evaluate(() =>
    (
      window as unknown as {
        __AGI_PROJECT__: { query: WorkerQueryFn };
      }
    ).__AGI_PROJECT__.query("state"),
  );
  expect(state?.vars[0]).toBe(8);
  expect(state?.vars[1]).toBe(7);
  expect(state?.vars[90]).toBe(123);
  expect(state?.flags[77]).toBe(1);
  await page
    .getByTestId("workspace-problems")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.reload();
  const latest = page.getByTestId("start-latest-version");
  await expect
    .poll(async () => (await latest.isVisible()) || (await textHook(page)).room === 1)
    .toBe(true);
  if (await latest.isVisible()) await latest.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await open(page, "part-room:8:logic");
  await page.getByTestId("workspace-update-menu").click();
  await expect(choice).toBeVisible();
  await expect(choice).toHaveAttribute("aria-current", "true");
});
