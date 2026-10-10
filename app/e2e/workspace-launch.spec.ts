import { systemName } from "../../src/logic/systemNames.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerQueryFn } from "../src/worker/workerProtocol.ts";
import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { textHook, screenText, workspaceSaved } from "./engineProbe.ts";
import {
  findWorkspaceLogic,
  focusWorkspaceLogic,
  runningWorkspaceDocument,
} from "./workspaceShared.ts";

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
  test.describe(`Launch metadata ${width}`, () => {
    test.use({ hasTouch: width === 390 });
    test(`Launch metadata saves without a game Update ${width} @webkit-desktop`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width, height });
      await start(page);
      await open(page, "part-room:1:logic");
      await page.getByTestId("workspace-update-menu").click();
      await page.getByRole("menuitem", { name: "New launch…" }).click();
      const launch = page.getByTestId("launch-editor");
      await expect(launch).toBeVisible();
      const name = page.getByTestId("launch-name-input");
      await expect(name).toBeVisible();
      await workspaceSaved(page);
      await name.fill("Practice");
      // An older metadata publication must not replace text awaiting its change event.
      await page.evaluate(async () => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        const world = JSON.parse(String(session.workingSnapshot().read("world")!.content));
        world.launches["1"].entries[0].note = "Starting setup";
        await session.stage([{ key: "world", content: JSON.stringify(world) }]);
      });
      await workspaceSaved(page);
      await expect(name).toHaveValue("Practice");
      await name.press("Tab");
      await workspaceSaved(page);
      await launchShot(page, `launch-metadata-${width}`, browserName);
      const action = page.getByTestId("workspace-update");
      await expect(action).toBeVisible();
      await expect(action).toHaveAccessibleName("Restart Home");
      expect(
        await page.evaluate(async () => {
          const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
          const data = await loadAuthoredGame(location.hash.split("/")[1] as never);
          const document = data!.workspace!.documents.find((doc) => doc.key === "world")!.content;
          if (document.type !== "text") throw new Error("Expected world text");
          return JSON.parse(document.text).launches["1"].entries[0].name;
        }),
      ).toBe("Practice");
      await page.reload();
      await workspaceSaved(page);
      await page.getByTestId("workspace-update-menu").click();
      await expect(page.getByRole("menuitem", { name: "Practice", exact: true })).toBeVisible();
    });
  });
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
      await expect(action).toHaveAccessibleName("Restart Home");
      await expect(action).toHaveClass(/ui-btn--secondary/);
      await launchShot(page, `restart-${width}`, browserName);
      await open(page, "part-room:8:logic");
      await expect(
        page.getByTestId("workspace-logic-editor").filter({ visible: true }),
      ).toBeVisible();
      expect((await textHook(page)).room).toBe(1);
      await expect(action).toHaveAccessibleName("Play Garden");
      await expect(action).toHaveAttribute("title", "Play Garden (F5 / ⌘↵ / Ctrl+Enter)");
      const cleanWidth = (await action.boundingBox())!.width;
      await launchShot(page, `play-${width}`, browserName);
      const source = await runningWorkspaceDocument(page, "logic:8");
      await focusWorkspaceLogic(page);
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText(
        source.replace("accept.input();", 'accept.input(); print("Launch updated");'),
      );
      await page.keyboard.press("Escape");
      await workspaceSaved(page);
      await expect(action).toHaveAccessibleName("Update and restart Garden");
      // The update icon takes the place of the play icon, filled: no word, no shift.
      await expect(action).toHaveText("Garden");
      await expect(action).toHaveClass(/ui-btn--primary/);
      expect((await action.boundingBox())!.width).toBeCloseTo(cleanWidth, 0);
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
      // The accessible name includes the selected launch.
      await expect(action).toHaveAccessibleName(
        "Restart Garden with the launch From the beginning",
      );
      await expect(action).toHaveText(/^Garden\s*·\s*From the beginning$/);
      await launchShot(page, `launch-${width}`, browserName);
      expect((await textHook(page)).room).toBe(8);
      await open(page, "part-room:1:logic");
      await expect(action).toHaveAccessibleName("Play Home");
      await open(page, "part-room:8:logic");
      await expect(action).toHaveAccessibleName(
        "Restart Garden with the launch From the beginning",
      );
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
  await expect(action).toHaveAccessibleName("Play Garden");
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
  await expect(action).toHaveAccessibleName("Update and restart Home");
  await action.click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "draftFlushHeld"))).toBe(true);
  await open(page, "part-room:8:logic");
  await page.evaluate(() => Reflect.get(window, "releaseDraftFlush")());
  const result = page.getByTestId("workspace-updated");
  await expect(result).toBeVisible();
  await expect(result).toContainText("Updated · Home restarted");
  expect((await textHook(page)).room).toBe(1);
  await expect(action).toHaveAccessibleName("Play Garden");
});

test("F5 in room LOGIC runs the selected Launch with its breakpoint armed @webkit-desktop", async ({
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
  await findWorkspaceLogic(page, "assignn(v100,8)");
  await page.keyboard.press("F9");
  await expect(page.locator(".workspace-breakpoint")).toHaveCount(1);
  await page.keyboard.press("F5");
  const status = page.getByTestId("workspace-debug-status");
  await expect(status).toBeVisible();
  // Shared labels name the LOGIC when it has a name: "Paused at room_logic · LOGIC 8".
  await expect(status).toContainText(/Paused at (\S+ · )?LOGIC 8/);
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
  await expect(action).toHaveAccessibleName("Play Meadow");

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

  // Renumbering publishes a new keyed row; wait for its rendered value before toggling.
  const flagSelect = page.getByTestId("launch-flag-select");
  await flagSelect.selectOption("70");
  await expect(flagSelect).toHaveAttribute("value", "70");
  const flagToggle = page.getByTestId("launch-flag-toggle");
  if ((await flagToggle.getAttribute("aria-checked")) === "false") await flagToggle.click();
  await expect(flagToggle).toHaveAttribute("aria-checked", "true");

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

  // 7. The button names the selected launch; click it to start Room 2 with it.
  await expect(action).toHaveAccessibleName(/ Meadow with the launch Launch 1$/);
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
  await expect(action).toHaveAccessibleName("Restart Meadow with the launch Launch 1");
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
    const nextWorld = { ...world };
    delete nextWorld.rooms["2"];
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

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`room removal names Launch changes and one Undo restores both ${width} @webkit-desktop`, async ({
    page,
    browserName,
  }) => {
    const { configureAi, openWorkspaceAgent } = await import("./engineProbe.ts");
    const { providerReply } = await import("../../test/provider-stream.ts");
    await page.setViewportSize({ width, height });
    await start(page);
    const beforeWorld = await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const capture = session.model.capture();
      const world = JSON.parse(String(capture.read("world")!.content));
      world.launches = {
        "8": { selected: "cart", entries: [{ id: "cart", name: "At the cart" }] },
        "1": {
          entries: [
            {
              id: "path",
              name: "Along the path",
              cameFrom: { room: 8, edge: 3 },
              items: { "0": 8 },
            },
          ],
        },
      };
      const text = JSON.stringify(world);
      const result = await session.submit({
        proposal: session.model.propose(capture, "Launch setups", [
          { key: "world", content: text },
        ]),
        origin: "logic",
        label: "Launch setups",
        author: "creator",
      });
      if (result.status !== "committed") throw new Error(result.status);
      return text;
    });
    await workspaceSaved(page);
    await open(page, "part-room:8:logic");
    await page.getByTestId("workspace-update-menu").click();
    const cart = page.getByRole("menuitem", { name: "At the cart" });
    await expect(cart).toBeVisible();
    await cart.click();
    await configureAi(page, { provider: "openai", key: "test-placeholder" });
    const world = JSON.parse(beforeWorld);
    delete world.rooms["8"];
    let replies = 0;
    await page.route("**/api/openai/v1/responses", async (route) => {
      await route.fulfill(
        providerReply("openai", {
          id: `remove-${++replies}`,
          output:
            replies === 1
              ? [
                  {
                    type: "function_call",
                    call_id: "remove-room",
                    name: "propose_changes",
                    arguments: JSON.stringify({
                      label: "Remove Garden",
                      changes: [
                        { key: "logic:8", content: null },
                        { key: "picture:8", content: null },
                        { key: "world", content: JSON.stringify(world) },
                      ],
                    }),
                  },
                ]
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Remove Garden." }],
                  },
                ],
        }),
      );
    });
    await openWorkspaceAgent(page);
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("agent-message").fill("Remove Garden and its picture");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    const review = page.getByTestId("agent-review");
    await expect(review).toBeVisible();
    await expect(
      review.getByText("Also removes the Launch “At the cart”.", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByText("“Along the path” starts without Came from.", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByText("Item 0 in “Along the path” carries over.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("agent-approve")).toBeEnabled();
    const codeDiff = review.getByTestId("agent-code-diff").first();
    await expect(codeDiff).toBeVisible();
    await expect.poll(() => codeDiff.locator(".line-delete").count()).toBeGreaterThan(0);
    const launchChanges = review.getByTestId("launch-removal-change");
    await launchChanges.first().scrollIntoViewIfNeeded();
    await expect(launchChanges.first()).toBeInViewport({ ratio: 1 });
    await expect(launchChanges.last()).toBeInViewport({ ratio: 1 });
    const snapshot = await page.screenshot({
      path: test.info().outputPath(`removal-preview-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    if (process.env["CI"] && browserName === "webkit")
      console.log(`LAUNCH_PRUNE_SHOT:preview-${width}:${snapshot.toString("base64")}`);
    await page.getByTestId("agent-approve").click();
    await expect(review).toBeHidden();
    await workspaceSaved(page);
    const pruned = JSON.parse(String(await runningWorkspaceDocument(page, "world")));
    expect(pruned.launches).toEqual({ "1": { entries: [{ id: "path", name: "Along the path" }] } });
    expect(
      await page.evaluate(() =>
        (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
          .getSession()
          .model.capture()
          .read("logic:8"),
      ),
    ).toBeUndefined();
    await page.getByRole("button", { name: "Undo this", exact: true }).click();
    await workspaceSaved(page);
    expect(await runningWorkspaceDocument(page, "world")).toBe(beforeWorld);
    expect(await runningWorkspaceDocument(page, "logic:8")).toContain("return;");
    // A deleted room's remembered selection also falls back when that number is reused.
    await page.evaluate(async () => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const capture = session.model.capture();
      const world = JSON.parse(String(capture.read("world")!.content));
      delete world.rooms["8"];
      const removed = await session.submit({
        proposal: session.model.propose(capture, "Remove room", [
          { key: "logic:8", content: null },
          { key: "world", content: JSON.stringify(world) },
        ]),
        origin: "logic",
        label: "Remove room",
        author: "creator",
      });
      if (!["committed", "restartRequired", "unchanged"].includes(removed.status))
        throw new Error(JSON.stringify(removed));
      const next = session.model.capture();
      const newWorld = JSON.parse(String(next.read("world")!.content));
      newWorld.rooms["8"] = { title: "Garden", description: "", exits: {} };
      await session.submit({
        proposal: session.model.propose(next, "Room again", [
          { key: "logic:8", content: "return;" },
          { key: "world", content: JSON.stringify(newWorld) },
        ]),
        origin: "logic",
        label: "Room again",
        author: "creator",
      });
    });
    await workspaceSaved(page);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await open(page, "part-room:8:logic");
    const menu = page.getByTestId("workspace-update-menu");
    await expect(menu).toBeVisible();
    await menu.click();
    const carry = page.getByRole("menuitem", { name: /Carry over/ });
    await expect(carry).toBeVisible();
    await expect(carry).toHaveAttribute("aria-current", "true");
  });
}

test("Launch dropdowns share built-in names and numeric order @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:logic");
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "New launch…" }).click();
  for (const kind of ["Flag", "Variable"]) {
    await page.getByTestId("launch-add-row-menu").click();
    await page.getByRole("menuitem", { name: kind, exact: true }).click();
  }
  const flags = page.getByTestId("launch-flag-select");
  const variables = page.getByTestId("launch-var-select");
  await expect(flags.locator('option[value="9"]')).toHaveText(`${systemName("flag", 9)} (Flag 9)`);
  await expect(variables.locator('option[value="3"]')).toHaveText(
    `${systemName("variable", 3)} (Variable 3)`,
  );
  await expect(flags.locator('option[value="204"]')).toHaveText("chime_done (Flag 204)");
  await expect(flags.locator('option[value="5"]')).toHaveCount(0);
  for (const num of [0, 2])
    await expect(variables.locator(`option[value="${num}"]`)).toHaveCount(0);
  for (const select of [flags, variables]) {
    const numbers = await select
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => Number((option as HTMLOptionElement).value)),
      );
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  }
  await page.screenshot({
    path: test.info().outputPath("launch-numbered-labels.png"),
    animations: "disabled",
  });
});
