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
  workspaceUpdated,
  openWorkspaceAgent,
  openWorkspacePicture,
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

test("Auto-approve shows a rejected handover without admitting its edits @webkit-desktop", async ({
  page,
}) => {
  let requests = 0;
  const catalogNames: string[][] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as { tools: { name: string }[] };
    catalogNames.push(body.tools.map((tool) => tool.name));
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `handover-${requests}`,
        status: "completed",
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  id: "test",
                  call_id: "test",
                  name: "write_game_tests",
                  arguments: JSON.stringify({
                    mode: "merge",
                    names: null,
                    tests: [
                      {
                        name: "Impossible score",
                        room: 1,
                        spawnX: null,
                        spawnY: null,
                        steps: [{ action: "wait", ticks: 1 }],
                        expect: { score: 99 },
                        cycleBudget: 100,
                      },
                    ],
                  }),
                },
                {
                  type: "function_call",
                  id: "finish",
                  call_id: "finish",
                  name: "finish",
                  arguments: '{"notes":null}',
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Done." }],
                },
              ],
      }),
    );
  });
  await start(page, "openai");
  const before = await documents(page);
  await page.getByRole("radio", { name: "Auto-approve", exact: true }).click();
  await page.getByTestId("agent-message").fill("Record and validate the score test");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("workspace-agent-panel").getByRole("alert")).toContainText(
    "Handover rejected",
  );
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  expect(await documents(page)).toEqual(before);
  expect(requests).toBe(2);
  expect(catalogNames[0]).toContain("configure_launch");
  expect(catalogNames[1]).toEqual(catalogNames[0]);
  await page.screenshot({
    path: test.info().outputPath("rejected-handover.png"),
    animations: "disabled",
  });
});
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
        .click({ position: { x: 24, y: 8 } });
      await page.keyboard.press("Home");
      for (let line = 0; line < 6; line++) await page.keyboard.press("Shift+ArrowDown");
      await expect(panel.locator(".agent-panel__context")).toBeVisible();
      await expect(panel.locator(".agent-panel__context")).toContainText("LOGIC 1 · lines 5–11");
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
    await expect(page.getByTestId("agent-auto-approve")).toBeVisible();
    await expect(page.getByTestId("agent-auto-approve")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("agent-auto-approve")).toHaveAttribute(
      "title",
      "Review asks before applying changes. Auto-approve applies them as they arrive.",
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
    await expect(page.getByRole("button", { name: "Chats", exact: true })).toHaveText("Chats");
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: "Add a welcome sign", exact: true }).click();
    await expect(page.getByRole("button", { name: "Undo this", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo this", exact: true }).click();
    await expect.poll(async () => (await documents(page))["picture:1"]).toBe(before["picture:1"]);
  });
}

test("Agent toggles from composer, editor and game and Escape returns to the originating editor @webkit-desktop", async ({
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
  await expect(panel).toBeHidden();
  await expect(logic).toBeFocused();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(panel).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("keyboard-1440.png") });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(panel).toBeHidden();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(composer).toBeFocused();
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`agent panel opaque header, single New chat, Close button and Escape ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await isolateStorage(page);
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await page.goto("/#create-adventure");
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill("Agent proof");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect(page.getByTestId("create-adventure-disclosure")).toBeHidden();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);

    if (size.width <= 600) {
      await page.getByTestId("workspace-parts").click();
    }
    await openWorkspacePicture(page, 1);
    await openWorkspaceAgent(page);
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    const header = panel.locator(".agent-panel__header");
    await expect(header).toBeVisible();

    const bg = await header.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");

    await expect(header.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);
    await expect(header.getByText("New chat", { exact: true })).toHaveCount(1);

    const closeBtn = panel.getByRole("button", { name: "Close", exact: true });
    await expect(closeBtn).toBeVisible();

    await page.screenshot({ path: test.info().outputPath(`agent-panel-${size.width}-after.png`) });

    // Recreate before bug state (transparent header and panel, duplicate New chat title, no close button)
    await page.evaluate(() => {
      const h = document.querySelector(".agent-panel__header") as HTMLElement | null;
      const p = document.querySelector(".agent-panel") as HTMLElement | null;
      const c = document.querySelector("[data-testid=agent-panel-close]") as HTMLElement | null;
      const t = document.querySelector(".agent-panel__chat-title") as HTMLElement | null;
      if (h) h.style.background = "transparent";
      if (p) p.style.background = "transparent";
      if (c) c.style.display = "none";
      if (t && t.childNodes[0]) t.childNodes[0].nodeValue = "New chat ";
    });
    await page.screenshot({ path: test.info().outputPath(`agent-panel-${size.width}-before.png`) });

    await page.evaluate(() => {
      const h = document.querySelector(".agent-panel__header") as HTMLElement | null;
      const p = document.querySelector(".agent-panel") as HTMLElement | null;
      const c = document.querySelector("[data-testid=agent-panel-close]") as HTMLElement | null;
      const t = document.querySelector(".agent-panel__chat-title") as HTMLElement | null;
      if (h) h.style.background = "";
      if (p) p.style.background = "";
      if (c) c.style.display = "";
      if (t && t.childNodes[0]) t.childNodes[0].nodeValue = "Chats ";
    });

    await closeBtn.click();
    await expect(panel).toBeHidden();

    await openWorkspaceAgent(page);
    await expect(panel).toBeVisible();
    // Esc outside the panel stays with the game and editors.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await panel.getByRole("textbox").first().press("Escape");
    await expect(panel).toBeHidden();
  });
}

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
  await workspaceUpdated(page);
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
  await workspaceUpdated(page);
  await reopen();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
});

test("stored workspace reference art sends a handle and thumbnail to the shared provider", async ({
  page,
}) => {
  const { encodePngRgb } = await import("../../src/picture/png.ts");
  let request:
    { input?: { content?: { type: string; text?: string; image_url?: string }[] }[] } | undefined;
  await page.route("**/api/openai/v1/responses", async (route) => {
    request = route.request().postDataJSON() as typeof request;
    await route.fulfill(
      providerReply("openai", {
        id: "reference-preview",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Reference received." }],
          },
        ],
      }),
    );
  });
  await start(page, "openai");
  const panel = page.getByTestId("workspace-agent-panel");
  await panel.getByTestId("agent-attach-reference").click();
  const upload = page.getByTestId("reference-upload");
  await expect(upload).toBeVisible();
  await upload.getByTestId("reference-room-file").setInputFiles({
    name: "bridge.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgb(1, 1, new Uint8Array([0, 0, 170]))),
  });
  await upload.getByTestId("reference-attach").click();
  await expect(upload.getByTestId("reference-staged")).toBeVisible();
  await upload.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto("/");
  await page.reload();
  await openStoredWorkspace(page, "Agent proof");
  await openWorkspaceAgent(page);
  await expect(panel).toBeVisible();
  await panel.getByTestId("agent-message").fill("Describe the attached reference");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel).toContainText("Reference received.");
  const content = request?.input?.flatMap((entry) => entry.content ?? []) ?? [];
  expect(content.map((entry) => entry.text ?? "").join("\n")).toMatch(/art-[0-9a-f]{10}/);
  const images = content.filter((entry) => entry.type === "input_image");
  expect(images).toHaveLength(1);
  const png = Buffer.from(images[0]!.image_url!.split(",")[1]!, "base64");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([72, 72]);
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
