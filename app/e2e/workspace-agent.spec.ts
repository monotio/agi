import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "./test.ts";
import {
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
} from "./workspaceShared.ts";
import {
  isolateStorage,
  textHook,
  configureAi,
  workspaceSaved,
  openWorkspaceAgent,
} from "./engineProbe.ts";
import type { Page } from "@playwright/test";
async function start(page: Page, provider: "stub" | "openai" = "stub", openLogic = true) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, {
    provider,
    ...(provider === "openai" ? { key: "test-placeholder" } : {}),
  });
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Agent proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("create-adventure-disclosure")).toBeHidden();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  if (openLogic) {
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await openWorkspaceLogic(page);
    await page.keyboard.press("ControlOrMeta+i");
  } else {
    await openWorkspaceAgent(page);
  }
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
}
async function documents(page: Page) {
  return page.evaluate(() => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): { model: { capture(): { documents(): Record<string, string> } } };
        };
      }
    ).__AGI_PROJECT__.getSession();
    return session.model.capture().documents();
  });
}
for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`workspace agent reviews coordinated changes and keyboard approval ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await start(page);
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel.locator(".agent-panel__context")).toContainText("LOGIC 1");
    await expect(panel.locator(".agent-panel__context")).toContainText("Meadow");
    await expect(panel.locator(".agent-panel__context")).not.toContainText("logic:1");
    const modes = panel.getByRole("radiogroup", { name: "Agent changes" });
    await expect(modes.getByRole("radio", { name: "Review", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(modes.getByRole("radio", { name: "Auto-approve", exact: true })).toHaveCount(1);
    await expect(modes).toHaveCSS("white-space", "nowrap");
    if (size.width === 1440) {
      await page
        .getByTestId("workspace-logic-editor")
        .locator(".view-line")
        .filter({ hasText: "draw.pic(v50);" })
        .click();
      await page.keyboard.press("Home");
      for (let line = 0; line < 6; line++) await page.keyboard.press("Shift+ArrowDown");
      await expect(panel.locator(".agent-panel__context")).toBeVisible();
      await expect(panel.locator(".agent-panel__context")).toContainText("LOGIC 1 lines 5–11");
    }
    const before = await documents(page);
    const cycle = (await textHook(page)).cycle;
    await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
    await page.getByTestId("agent-message").fill("Add a welcome sign");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await expect(page.getByTestId("agent-code-diff")).toBeVisible();
    await expect(page.getByTestId("agent-art-review")).toBeVisible();
    expect((await documents(page))["logic:1"]).toBe(before["logic:1"]);
    await expect
      .poll(() => page.getByTestId("agent-code-diff").locator(".line-insert").count())
      .toBeGreaterThan(0);
    await expect(page.getByTestId("agent-art-review").locator("img").first()).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByTestId("agent-approve")).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: test.info().outputPath(`review-${size.width}x${size.height}.png`),
      animations: "disabled",
    });
    await page.getByTestId("agent-message").focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("agent-review")).toHaveCount(0);
    await expect.poll(async () => (await documents(page))["logic:1"]).not.toBe(before["logic:1"]);
    await page.getByRole("button", { name: "Undo this", exact: true }).click();
    await expect.poll(async () => (await documents(page))["logic:1"]).toBe(before["logic:1"]);
    expect((await documents(page))["picture:1"]).toBe(before["picture:1"]);
    await page.getByTestId("agent-message").fill("Add a welcome sign");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    await page.getByTestId("agent-reject").click();
    expect((await documents(page))["logic:1"]).toBe(before["logic:1"]);
  });
  test(`workspace agent auto-approves and retains task chats ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    const before = await documents(page);
    await page.getByTestId("agent-auto-approve").click();
    await expect(page.getByTestId("agent-auto-approve")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("agent-auto-approve")).toHaveAttribute(
      "title",
      /Undo takes them back/,
    );
    await page.evaluate(() => {
      const panel = document.querySelector("[data-testid=workspace-agent-panel]")!;
      panel.setAttribute("data-review-seen", "false");
      new MutationObserver(() => {
        if (panel.querySelector("[data-testid=agent-review]"))
          panel.setAttribute("data-review-seen", "true");
      }).observe(panel, { childList: true, subtree: true });
    });
    await page.getByTestId("agent-message").fill("Add a welcome sign");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Undo this", exact: true })).toBeVisible();
    await expect(page.getByTestId("agent-review")).toHaveCount(0);
    await expect(page.getByTestId("workspace-agent-panel")).toHaveAttribute(
      "data-review-seen",
      "false",
    );
    expect((await documents(page))["picture:1"]).not.toBe(before["picture:1"]);
    await page.screenshot({
      path: test.info().outputPath(`auto-approve-${size.width}x${size.height}.png`),
      animations: "disabled",
    });
    await page.getByTestId("agent-message").focus();
    await page.keyboard.press("ControlOrMeta+n");
    await expect(page.getByRole("button", { name: "Chats", exact: true })).toHaveText("New chat");
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: "Add a welcome sign", exact: true }).click();
    await expect(page.getByRole("button", { name: "Undo this", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo this", exact: true }).click();
    await expect.poll(async () => (await documents(page))["picture:1"]).toBe(before["picture:1"]);
  });
}

test("Agent toggles from composer, editor and game and Escape returns to the originating editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const panel = page.getByTestId("workspace-agent-panel");
  const composer = panel.getByTestId("agent-message");
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(panel).toBeHidden();
  const logic = page.getByTestId("workspace-logic-editor").locator(".inputarea");
  await logic.focus();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(composer).toBeFocused();
  await composer.fill("Keep this draft");
  await composer.press("Escape");
  await expect(composer).toBeFocused();
  await composer.fill("");
  await composer.press("Escape");
  await expect(logic).toBeFocused();
  await expect(panel).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("keyboard-1440.png") });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(panel).toBeHidden();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(composer).toBeFocused();
});

test("Approve admits a said response before Create game input", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const input = page.getByTestId("input-line");
  if ((await textHook(page)).modal) {
    await input.focus();
    await input.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  }
  await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("agent-code-diff").locator(".line-insert").count())
    .toBeGreaterThan(0);
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect
    .poll(async () => (await documents(page))["logic:1"])
    .toContain('said("look", "sign")');
  const composer = page.getByTestId("agent-message");
  await composer.pressSequentially("look at sign");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await composer.fill("");
  await expect(input).toBeEnabled();
  await input.focus();
  await input.fill("look at sign");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("Welcome sign");
  await page.screenshot({ path: test.info().outputPath("approved-sign-1440.png") });
});

test("Agent replies render safe Markdown", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/openai/v1/responses", async (route) => {
    await route.fulfill(
      providerReply("openai", {
        id: "markdown",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: 'Hello **builder** and *player*.\n\n- Use `said()`.\n- Read words.\n\n1. Look\n2. Open\n\n```agi\nprint("Welcome");\n```\n\n<img src=x onerror="window.injected=true">',
              },
            ],
          },
        ],
      }),
    );
  });
  await start(page, "openai");
  await page.getByTestId("agent-message").fill("Explain commands");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page.locator(".agent-panel__markdown").last();
  await expect(reply.locator("strong")).toHaveText("builder");
  await expect(reply.locator("em")).toHaveText("player");
  await expect(reply.locator("ul li")).toHaveCount(2);
  await expect(reply.locator("ol li")).toHaveCount(2);
  await expect(reply.locator("li code")).toHaveText("said()");
  await expect(reply.locator("pre code")).toHaveText('print("Welcome");');
  await expect(reply.locator("img")).toHaveCount(0);
  await expect(reply).toContainText('<img src=x onerror="window.injected=true">');
  await page.screenshot({ path: test.info().outputPath("markdown-1440.png") });
});

test("saved reviews reopen with previews and detect a changed base", async ({ page }) => {
  await start(page);
  const before = await documents(page);
  await page.getByTestId("agent-message").fill("Add a welcome sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await workspaceSaved(page);
  async function reopen() {
    await page.goto("/");
    await page.reload();
    await openStoredWorkspace(page, "Agent proof");
    await openWorkspaceAgent(page);
  }
  await reopen();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect(page.getByTestId("agent-art-review").locator("img").first()).toBeVisible();
  await expect
    .poll(() => page.getByTestId("agent-code-diff").locator(".line-insert").count())
    .toBeGreaterThan(0);
  await expect(page.getByTestId("agent-approve")).toBeEnabled();
  expect((await documents(page))["logic:1"]).toBe(before["logic:1"]);
  await page.screenshot({ path: test.info().outputPath("saved-review.png") });
  await replaceWorkspaceDocument(page, "logic:0", `${before["logic:0"]}\n// Human edit\n`);
  await reopen();
  await expect(page.getByTestId("agent-conflict")).toBeVisible();
  await expect(page.getByTestId("agent-approve")).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("stale-review.png") });
  await page.getByTestId("agent-reject").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await workspaceSaved(page);
  await reopen();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
});

test("the workspace composer offers reference art", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const attach = page.getByTestId("workspace-agent-panel").getByTestId("agent-attach-reference");
  await expect(attach).toBeVisible();
  await attach.click();
  await expect(page.getByTestId("reference-upload")).toBeVisible();
});

test("a slow preview keeps Approve working through preview loading", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/AgentResourceReview.vue*", async (route) => {
    await held;
    await route.continue();
  });
  await start(page, "stub", false);
  await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review-loading").first()).toBeVisible();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect(page.getByTestId("agent-approve")).toBeVisible();
  await expect(page.getByTestId("agent-approve")).toBeEnabled();
  await expect(page.getByTestId("agent-reject")).toBeVisible();
  // Read the proposal, then press Approve while its previews are still loading.
  await page.getByTestId("agent-review").getByRole("heading").scrollIntoViewIfNeeded();
  const approve = page.getByTestId("agent-approve");
  await approve.scrollIntoViewIfNeeded();
  await expect(approve).toBeInViewport({ ratio: 1 });
  await approve.evaluate((button) => {
    button.setAttribute("data-pressed", "false");
    button.addEventListener("mousedown", () => button.setAttribute("data-pressed", "true"), {
      once: true,
    });
  });
  const before = (await approve.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await expect(approve).toHaveAttribute("data-pressed", "true");
  release();
  await expect(page.getByTestId("agent-review-loading")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect
    .poll(async () => (await documents(page))["logic:1"])
    .toContain('said("look", "sign")');
});

test("a review whose preview code cannot load still offers Approve", async ({ page }) => {
  await page.route("**/AgentResourceReview.vue*", (route) => route.abort());
  await start(page);
  await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect(page.getByTestId("agent-preview-missing").first()).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect
    .poll(async () => (await documents(page))["logic:1"])
    .toContain('said("look", "sign")');
});
