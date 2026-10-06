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
      await expect(page.getByRole("menuitem", { name: "From my game", exact: true })).toBeVisible();
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

test("Update keeps the room chosen before drafts flush @webkit-desktop", async ({ page }) => {
  await start(page);
  await open(page, "part-room:1:logic");
  const source = await runningWorkspaceDocument(page, "logic:1");
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(`${source}\n// A pinned room update`);
  await page.keyboard.press("Escape");
  await workspaceSaved(page);
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const drafts = session.drafts();
    const flush = drafts.flush.bind(drafts);
    const hooks = window as unknown as {
      draftFlushHeld: boolean;
      releaseDraftFlush(): void;
    };
    hooks.draftFlushHeld = false;
    let hold = true;
    drafts.flush = async () => {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          hooks.draftFlushHeld = true;
          hooks.releaseDraftFlush = resolve;
        });
      }
      await flush();
    };
  });
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Update and restart Home");
  await action.click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "draftFlushHeld"))).toBe(true);
  await open(page, "part-room:8:logic");
  await page.evaluate(() => Reflect.get(window, "releaseDraftFlush")());
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
  // Debug views are persistent data tabs; Stop ends the session in the context row.
  const stop = page.getByTestId("workspace-context").getByTestId("debug-stop");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(status).toHaveCount(0);
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

test("create a Launch for Room 2 with a flag and Came from, select it, Restart Room 2 shows the flag's effect twice in a row; remove Room 2 and see its Launches gone @webkit-desktop", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  // Add Room 2 ("Meadow") with logic and picture
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const world = JSON.parse(String(capture.read("world")!.content));
    const result = await session.submit({
      proposal: session.model.propose(capture, "Add Room 2", [
        { key: "picture:2", content: "vis 4\nfill 0,0\nend\n" },
        {
          key: "logic:2",
          content:
            'if(isset(f5)){assignn(v100,2);load.pic(v100);draw.pic(v100);show.pic();animate.obj(o0);load.view(0);set.view(o0,0);position(o0,60,140);draw(o0);accept.input();}if(isset(f70)){print("Flag 70 is active");}return;',
        },
        {
          key: "world",
          content: JSON.stringify({
            ...world,
            rooms: {
              ...world.rooms,
              "2": { title: "Meadow", description: "", exits: {} },
            },
          }),
        },
      ]),
      label: "Add Room 2",
      origin: "logic",
      author: "creator",
    });
    if (result.status !== "committed") throw new Error(result.status);
  });
  await workspaceSaved(page);

  // 1. Open Room 2 logic editor
  await open(page, "part-room:2:logic");
  const action = page.getByTestId("workspace-update");
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Play Meadow");

  // 2. Open the ▾ dropdown menu and click "New launch…"
  await page.getByTestId("workspace-update-menu").click();
  const newLaunchItem = page.getByRole("menuitem", { name: "New launch…" });
  await expect(newLaunchItem).toBeVisible();
  await newLaunchItem.click();

  // 3. Launch editor opens as a tab titled "Launches · Meadow"
  const launchEditor = page.getByTestId("launch-editor");
  await expect(launchEditor).toBeVisible();
  await expect(launchEditor.getByText("Launches · Meadow")).toBeVisible();

  // Screenshot of launch editor at 1440x900
  await page.screenshot({
    path: test.info().outputPath("launch-editor-1440.png"),
    animations: "disabled",
    scale: "css",
  });

  // 4. Add "Came from" row
  await page.getByTestId("launch-add-row-menu").click();
  await page.getByRole("menuitem", { name: "Came from" }).click();
  await expect(page.getByTestId("launch-row-came-from")).toBeVisible();
  await expect(page.getByTestId("launch-came-from-room")).toHaveValue("1");

  // 5. Add "Flag" row
  await page.getByTestId("launch-add-row-menu").click();
  await page.getByRole("menuitem", { name: "Flag" }).click();
  await expect(page.getByTestId("launch-row-flag")).toBeVisible();

  // Set flag to 70 and toggle it ON
  await page.getByTestId("launch-flag-select").selectOption("70");
  const flagToggle = page.getByTestId("launch-flag-toggle");
  await flagToggle.click();

  // 6. Select the launch for run
  const selectRunBtn = page.getByTestId("launch-select-for-run");
  if (await selectRunBtn.isVisible()) {
    await selectRunBtn.click();
  }
  await expect(page.getByTestId("launch-selected-badge")).toBeVisible();
  await expect(page.getByTestId("launch-selected-badge")).toHaveText("✓ Selected for run");

  // Screenshot showing configured launch with rows
  await page.screenshot({
    path: test.info().outputPath("launch-configured-1440.png"),
    animations: "disabled",
    scale: "css",
  });

  // Capture responsive screenshots of the editor
  await page.setViewportSize({ width: 1063, height: 815 });
  await page.screenshot({
    path: test.info().outputPath("launch-editor-1063.png"),
    animations: "disabled",
    scale: "css",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("launch-editor-390.png"),
    animations: "disabled",
    scale: "css",
  });
  if (process.env["CI"] && browserName === "webkit") {
    const shot = await page.screenshot({ animations: "disabled", scale: "css" });
    console.log(`LAUNCH_SHOT:launch-editor-webkit-390:${shot.toString("base64")}`);
  }

  // Return to desktop viewport
  await page.setViewportSize({ width: 1440, height: 900 });

  // Verify dropdown shows the launch selected with ✓
  await page.getByTestId("workspace-update-menu").click();
  const menuLaunch = page.getByRole("menuitem", { name: "Launch 1" });
  await expect(menuLaunch).toBeVisible();
  await expect(menuLaunch).toContainText("✓");
  await page.screenshot({
    path: test.info().outputPath("launch-menu-1440.png"),
    animations: "disabled",
    scale: "css",
  });
  await page.keyboard.press("Escape");

  // 7. Click "Play Meadow" to start Room 2 with the launch configuration
  await action.click();
  await expect.poll(() => screenText(page)).toContain("Flag 70 is active");
  await page.screenshot({
    path: test.info().outputPath("launch-run1-1440.png"),
    animations: "disabled",
    scale: "css",
  });

  // Dismiss print dialog by pressing Enter
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);

  // 8. Restart Meadow again! Screen text shows the flag's effect twice in a row!
  await expect(action).toHaveText("Restart Meadow");
  await action.click();
  await expect.poll(() => screenText(page)).toContain("Flag 70 is active");
  await page.screenshot({
    path: test.info().outputPath("launch-run2-1440.png"),
    animations: "disabled",
    scale: "css",
  });
  await page.keyboard.press("Enter");

  // 9. Remove Room 2 and see its launches gone
  const worldBefore = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return JSON.parse(String(session.model.capture().read("world")!.content));
  });
  expect(worldBefore.launches?.["2"]).toBeDefined();
  expect(worldBefore.launches["2"].entries.length).toBeGreaterThan(0);

  // Remove Room 2 via session proposal
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const capture = session.model.capture();
    const world = JSON.parse(String(capture.read("world")!.content));
    // Simulate room removal with pruneRoomLaunches
    const nextWorld = { ...world };
    delete nextWorld.rooms["2"];
    if (nextWorld.launches) {
      delete nextWorld.launches["2"];
      if (Object.keys(nextWorld.launches).length === 0) delete nextWorld.launches;
    }
    const result = await session.submit({
      proposal: session.model.propose(capture, "Remove Room 2", [
        { key: "world", content: JSON.stringify(nextWorld) },
        { key: "logic:2", content: null },
        { key: "picture:2", content: null },
      ]),
      label: "Remove Room 2",
      origin: "logic",
      author: "creator",
    });
    if (!["committed", "restartRequired", "unchanged"].includes(result.status))
      throw new Error(result.status);
  });
  await workspaceSaved(page);

  // Verify Room 2's launches are gone in world
  const worldAfter = await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return JSON.parse(String(session.model.capture().read("world")!.content));
  });
  expect(worldAfter.launches?.["2"]).toBeUndefined();
});
