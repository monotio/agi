import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import {
  textHook,
  configureAi,
  isolateStorage,
  waitForRoom,
  workspaceUpdated,
} from "./engineProbe.ts";
import {
  focusWorkspaceLogic,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";

test.use({ viewport: { width: 1440, height: 900 } });
async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("create-adventure-toggle").click();
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await workspaceUpdated(page);
}
async function findWord(page: Page, word: string): Promise<void> {
  await focusWorkspaceLogic(page);
  const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
  await page.keyboard.press(mac ? "Meta+f" : "Control+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeVisible();
  await find.fill(word);
  await find.press("Escape");
  await page.keyboard.press("ArrowLeft");
}
test("names open resources, peek game state and rename all authored uses @webkit-desktop", async ({
  page,
}) => {
  await start(page);
  const parts = page.getByTestId("parts-list");
  await expect(parts.getByRole("heading", { name: "GAME STATE", exact: true })).toBeVisible();
  await expect(
    parts.getByRole("button", { name: "chime_done Flag 204", exact: true }),
  ).toBeVisible();
  await parts.getByRole("button", { name: "chime_done Flag 204", exact: true }).click();
  const details = page.getByTestId("binding-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Changed · first_room · LOGIC 1");
  await details.getByRole("button", { name: "Rename", exact: true }).click();
  await details.getByLabel("Name", { exact: true }).fill("birdsong_done");
  await details.getByRole("button", { name: "Rename", exact: true }).click();
  await workspaceUpdated(page);
  expect(await workspaceDocument(page, "bindings")).toContain("birdsong_done");
  expect(await workspaceDocument(page, "logic:1")).toContain("sound(chime_sound, birdsong_done)");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    "load.sound(chime_sound);\nif (isset(birdsong_done)) { reset(birdsong_done); }\nreturn;",
  );
  await findWord(page, "chime_sound");
  await page.keyboard.press("F12");
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await expect(page.getByTestId("project-tab-sound:1")).toHaveAttribute("aria-selected", "true");
  await openWorkspaceLogic(page);
  await findWord(page, "birdsong_done");
  await page.keyboard.press("F12");
  await expect(details).toBeVisible();
  await expect(details.locator("header strong")).toHaveText("birdsong_done");
  const storedNumber = details.locator("header small");
  await expect(storedNumber).toBeVisible();
  await expect(storedNumber).toHaveText("Flag 204");
  expect((await storedNumber.boundingBox())!.y).toBeGreaterThan(
    (await details.locator("header strong").boundingBox())!.y,
  );
  await expect(page.locator(".monaco-editor")).not.toContainText("bindings.json");
  await expect(page.locator(".reference-zone-widget")).toHaveCount(0);
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("workspace-state")).toBeVisible();
    await expect(page.getByTestId("state-flag-204")).toBeFocused();
    await expect(details).toBeVisible();
    await expect(
      details.getByRole("button", { name: /Read · first_room · LOGIC 1/ }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`names-peek-${viewport.width}.png`),
      scale: "css",
    });
  }
});
test("Create agent keeps reading position and jumps to latest", async ({ page }) => {
  await start(page);
  await page.getByTestId("workspace-agent").click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  for (let index = 0; index < 3; index++) {
    await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await page.getByTestId("agent-reject").click();
    await expect(page.getByTestId("agent-review")).toBeHidden();
  }
  const feed = panel.locator(".agent-panel__feed");
  await feed.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(panel.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  const top = await feed.evaluate((node) => node.scrollTop);
  await page.getByTestId("agent-message").fill("Tell me about this room");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  expect(await feed.evaluate((node) => node.scrollTop)).toBe(top);
  await panel.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect
    .poll(() => feed.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(24);
  await page.screenshot({ path: test.info().outputPath("agent-latest.png") });
});

test("switching chats opens the latest messages", async ({ page }) => {
  await start(page);
  await page.getByTestId("workspace-agent").click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  const title = "Add a welcome sign that answers look at sign";
  for (let index = 0; index < 3; index++) {
    await page.getByTestId("agent-message").fill(title);
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await page.getByTestId("agent-reject").click();
    await expect(page.getByTestId("agent-review")).toBeHidden();
  }
  await panel.getByRole("button", { name: "Chats", exact: true }).click();
  await panel.getByRole("button", { name: "New chat", exact: true }).click();
  const secondTitle = "Tell me about this room";
  for (let index = 0; index < 3; index++) {
    await page.getByTestId("agent-message").fill(secondTitle);
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await page.getByTestId("agent-reject").click();
    await expect(page.getByTestId("agent-review")).toBeHidden();
  }
  const feed = panel.locator(".agent-panel__feed");
  await expect(feed).toBeVisible();
  await feed.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(panel.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  async function selectChat(name: string) {
    await panel.getByRole("button", { name: "Chats", exact: true }).click();
    const chat = panel
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name, exact: true });
    await expect(chat).toBeVisible();
    await chat.click();
  }
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(panel).toBeVisible();
    await selectChat(title);
    await page.screenshot({
      path: test.info().outputPath(`chat-switch-${viewport.width}.png`),
      scale: "css",
    });
    await expect
      .poll(() => feed.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(24);
    await expect(panel.getByRole("button", { name: "Jump to latest", exact: true })).toBeHidden();
    await selectChat(secondTitle);
    await feed.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect(panel.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  }
});

test("Create game owns F5 and F6 while the editor owns the run action", async ({ page }) => {
  await start(page);
  await openWorkspaceLogic(page);
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.press("F6");
  await expect(input).toBeFocused();
  await page.keyboard.press("F5");
  await expect.poll(async () => (await textHook(page)).modal).toBe("save");
  await expect(page.getByTestId("debug-stop")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await findWord(page, "assignn(v50, clearing_pic)");
  await page.keyboard.press("F9");
  await expect(page.locator(".workspace-breakpoint")).toHaveCount(1);
  await page.keyboard.press("F5");
  await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeVisible();
  await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeEnabled();
  await page.keyboard.press("Shift+F5");
  await expect(page.getByTestId("debug-stop")).toHaveCount(0);
  await expect(page.getByTestId("workspace-update")).toBeVisible();
  await focusWorkspaceLogic(page);
  await page.keyboard.press("F5");
  await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeVisible();
});

test("name hover opens resources and message actions keep readable text @webkit-desktop", async ({
  page,
}) => {
  await start(page);
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    '#message 1 "Hello there"\nload.sound(chime_sound);\nif (isset(chime_done)) { print(m1); }\nreturn;',
  );
  await focusWorkspaceLogic(page);
  const editor = page.getByTestId("workspace-logic-editor");
  await editor.locator(".view-lines").getByText("chime_sound", { exact: true }).hover();
  const hover = page.locator(".monaco-hover:not(.hidden)");
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("chime_sound · SOUND 1");
  await expect(hover.getByRole("link", { name: "Rename…", exact: true })).toBeVisible();
  await hover.getByRole("link", { name: "Rename…", exact: true }).click();
  const rename = editor.locator(".rename-box input").filter({ visible: true });
  await expect(rename).toBeFocused();
  await rename.fill("birdsong");
  await rename.press("Enter");
  await expect(rename).toBeHidden();
  await workspaceUpdated(page);
  await expect.poll(() => workspaceDocument(page, "logic:1")).toContain("load.sound(birdsong);");
  await page.getByTestId("workspace-context").hover();
  await editor.locator(".view-lines").getByText("birdsong", { exact: true }).hover();
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("birdsong · SOUND 1");
  await hover.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.getByTestId("workspace-sound")).toBeVisible();
  await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) {
      const part = page.getByTestId("part-room:1:logic");
      if (!(await part.isVisible())) await page.getByTestId("workspace-parts").click();
      await expect(part).toBeVisible();
      await part.click();
    }
    await expect(editor).toBeVisible();
    await expect(editor.locator(".view-lines")).toContainText(/m1\s+"Hello\s+there"/);
    await page.screenshot({
      path: test.info().outputPath(`message-hints-${viewport.width}.png`),
      scale: "css",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await findWord(page, "m1");
  const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
  await page.keyboard.press(mac ? "Meta+." : "Control+.");
  const inline = page.getByText("Put text inline", { exact: true });
  await expect(inline).toBeVisible();
  await inline.click();
  await workspaceUpdated(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('print("Hello there")');
  await findWord(page, 'Hello there");');
  await page.keyboard.press(mac ? "Meta+." : "Control+.");
  const numbered = page.getByText("Move text to #message", { exact: true });
  await expect(numbered).toBeVisible();
  await numbered.click();
  await workspaceUpdated(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('#message 2 "Hello there"');
  expect(await workspaceDocument(page, "logic:1")).toContain("print(m2)");
});

test("Home offers one Your own game card and neutral entries clear an AI pick", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await isolateStorage(page);
  await page.goto("/");
  const button = page.getByTestId("shelf-template-custom");
  await button.scrollIntoViewIfNeeded();
  const card = button.locator("xpath=ancestor::article");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Your own game");
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(card.getByRole("button")).toHaveCount(1);
  await expect(card.locator(".game-card__pill")).toHaveCount(0);
  await expect(card.locator(".game-card__meta")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("home-neutral-card.png") });
  // The AI templates live inside New game, not on the Home shelf.
  await expect(page.locator('[data-testid^="shelf-template-"]')).toHaveCount(1);
  await button.click();
  await page.getByTestId("local-create-kind-ai").click();
  await page.getByTestId("template-knights-trial").click();
  await expect(page.getByTestId("local-create-kind-ai")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("template-knights-trial")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("create-adventure-close").click();
  await page.getByTestId("create-adventure-toggle").click();
  await expect(
    page.getByRole("radiogroup", { name: "Starting point" }).locator('[aria-checked="true"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("local-create-submit")).toBeHidden();
  await page.getByTestId("create-adventure-close").click();
  await button.click();
  await expect(page.getByRole("radiogroup", { name: "Starting point" })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Starting point" }).locator('[aria-checked="true"]'),
  ).toHaveCount(0);
});

test("F5 runs from the parts list, header, agent and page without reloading", async ({ page }) => {
  await start(page);
  await openWorkspaceLogic(page);
  await findWord(page, "assignn(v50, clearing_pic)");
  await page.keyboard.press("F9");
  await expect(page.locator(".workspace-breakpoint")).toHaveCount(1);
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  for (const target of ["parts", "header", "agent", "page"]) {
    if (target === "parts") await page.getByTestId("part-room:1:logic").focus();
    else if (target === "header") await page.getByTestId("workspace-agent").focus();
    else if (target === "agent") {
      await page.getByTestId("workspace-agent").click();
      await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
      await page.getByTestId("agent-message").focus();
    } else
      await page.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
      });
    await page.keyboard.press("F5");
    await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeVisible();
    await expect(page.locator(".workspace-context").getByTestId("debug-stop")).toBeEnabled();
    await page.keyboard.press("Shift+F5");
    await expect(page.getByTestId("debug-stop")).toHaveCount(0);
  }
  expect(navigations).toBe(0);
});

test("switching names resets Rename and leaves both bindings unchanged", async ({ page }) => {
  await start(page);
  const before = await workspaceDocument(page, "bindings");
  const parts = page.getByTestId("parts-list");
  await expect(
    parts.getByRole("button", { name: "chime_done Flag 204", exact: true }),
  ).toBeVisible();
  await parts.getByRole("button", { name: "chime_done Flag 204", exact: true }).click();
  const details = page.getByTestId("binding-details");
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Rename", exact: true }).click();
  await details.getByLabel("Name", { exact: true }).fill("birdsong_done");
  await expect(parts.getByRole("button", { name: "dead Flag 202", exact: true })).toBeVisible();
  await parts.getByRole("button", { name: "dead Flag 202", exact: true }).click();
  await expect(details.locator("header strong")).toBeVisible();
  await expect(details.locator("header strong")).toHaveText("dead");
  await expect(details.getByLabel("Name", { exact: true })).toBeHidden();
  expect(await workspaceDocument(page, "bindings")).toBe(before);
});

test("built-in names appear in code, completion, hover and coordinated rename @webkit-desktop", async ({
  page,
}) => {
  await start(page);
  const builtin = page.getByTestId("parts-list").getByTestId("game-state-builtin");
  await builtin.locator(":scope > summary").click();
  await expect(
    builtin.getByRole("button", { name: "ego_in_water Flag 0", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("builtin-source-names.png"),
    animations: "disabled",
  });
  expect(await workspaceDocument(page, "logic:0")).toContain("call.v(current_room)");
  expect(await workspaceDocument(page, "logic:1")).toContain("isset(new_room)");
  await replaceWorkspaceDocument(page, "logic:1", "assignv(v50, cur); return;", false);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.hasTextFocus())!;
    editor.setPosition(editor.getModel()!.getPositionAt("assignv(v50, cur".length));
    editor.trigger("spec", "editor.action.triggerSuggest", {});
  });
  const suggestion = page.locator(".suggest-widget").filter({ visible: true });
  await expect(suggestion).toContainText("current_room");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toBe("assignv(v50, current_room); return;");
  await findWord(page, "current_room");
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    monaco.editor
      .getEditors()
      .find((editor) => editor.hasTextFocus())!
      .trigger("spec", "editor.action.showHover", {});
  });
  await expect(page.locator(".monaco-hover").filter({ visible: true })).toContainText(
    "current_room · Variable 0",
  );
  await page.keyboard.press("Escape");
  await findWord(page, "current_room");
  await page.keyboard.press("F2");
  const rename = page.locator(".rename-box input").filter({ visible: true });
  await expect(rename).toBeVisible();
  await rename.fill("room_number");
  await rename.press("Enter");
  await expect(rename).not.toBeVisible();
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toContain("assignv(v50, room_number)");
  await expect.poll(() => workspaceDocument(page, "logic:0")).toContain("call.v(room_number)");
  expect(await workspaceDocument(page, "bindings")).toContain('"room_number"');
  await workspaceUpdated(page);
  await page.screenshot({
    path: test.info().outputPath("builtin-renamed.png"),
    animations: "disabled",
  });
});
// Monaco defers an automatic code-action refresh that arrives during an explicit
// Quick Fix and later applies it (monacoCodeActions.ts). The deferred refresh must
// not cancel a newer Quick Fix that is still waiting for its answer.
test("a deferred automatic refresh keeps a newer Quick Fix and its message action @webkit-desktop", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { monaco, LOGIC_LANGUAGE_ID, registerLogicModel } =
      await import("/src/studio/logic/monacoLanguage.ts");
    const { LogicAnalysisClient } = await import("/src/studio/logic/analysisClient.ts");
    const dom = document.createElement("div");
    dom.style.cssText = "position:fixed;inset:0;z-index:10000";
    document.body.append(dom);
    const source = 'print("Hello there"); return;';
    const model = monaco.editor.createModel(source, LOGIC_LANGUAGE_ID);
    const client = new LogicAnalysisClient();
    client.setProject({
      revision: 1,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { source, version: 1 } },
    });
    const state = {
      hold: false,
      waiting: false,
      release: () => {},
      deferred: [] as (() => void)[],
    };
    const request = client.request.bind(client);
    client.request = async (...args) => {
      const result = await request(...args);
      if (args[1] === "textDocument/codeAction" && state.hold) {
        state.hold = false;
        state.waiting = true;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      return result;
    };
    const originalTimer = window.setTimeout;
    // Hold Monaco's deferred state change so it fires while the next explicit
    // request is pending, without relying on machine speed.
    const holdTimer = (handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
      if (
        delay === 500 &&
        typeof handler === "function" &&
        String(handler).includes(".setState(")
      ) {
        state.deferred.push(() => handler(...args));
        return 0;
      }
      return originalTimer(handler, delay, ...args);
    };
    window.setTimeout = holdTimer as typeof window.setTimeout;
    const handle = registerLogicModel(model, { client, documentKey: "logic:1" });
    const editor = monaco.editor.create(dom, { model, minimap: { enabled: false } });
    editor.setPosition({ lineNumber: 1, column: 9 });
    editor.focus();
    editor.trigger("test", "editor.action.quickFix", {});
    (window as unknown as { messageActionRace: unknown }).messageActionRace = {
      queued: () => state.deferred.length,
      waiting: () => state.waiting,
      move: () => editor.setPosition({ lineNumber: 1, column: 10 }),
      invoke: () => {
        state.hold = true;
        editor.trigger("test", "editor.action.quickFix", {});
      },
      release: () => {
        for (const callback of state.deferred.splice(0)) callback();
        state.release();
      },
      dispose: () => {
        window.setTimeout = originalTimer;
        handle.dispose();
        editor.dispose();
        client.dispose();
        model.dispose();
        dom.remove();
      },
    };
  });
  try {
    const action = page.getByText("Move text to #message", { exact: true });
    await expect(action).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(action).toBeHidden();
    await page.evaluate(() => {
      (window as unknown as { messageActionRace: { move(): void } }).messageActionRace.move();
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { messageActionRace: { queued(): number } }
          ).messageActionRace.queued(),
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as unknown as { messageActionRace: { invoke(): void } }).messageActionRace.invoke();
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { messageActionRace: { waiting(): boolean } }
          ).messageActionRace.waiting(),
        ),
      )
      .toBe(true);
    await page.evaluate(() => {
      (window as unknown as { messageActionRace: { release(): void } }).messageActionRace.release();
    });
    await expect(action).toBeVisible();
  } finally {
    await page.evaluate(() => {
      (window as unknown as { messageActionRace: { dispose(): void } }).messageActionRace.dispose();
    });
  }
});
