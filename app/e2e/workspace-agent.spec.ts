import { providerReply } from "../../test/provider-stream.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { disassembleLogic } from "../../src/logic/disassembler.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildZip } from "../src/archive/zip.ts";
import { test, expect } from "./test.ts";
import {
  addWorkspaceAction,
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
} from "./workspaceShared.ts";
import {
  isolateStorage,
  textHook,
  configureAi,
  workspaceUpdated,
  observe,
  openWorkspaceAgent,
  openWorkspacePicture,
  waitForCycles,
  waitForGameInput,
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
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
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

test("Agent finish names red tests: Auto-approve commits a failing test and runs the committed document @webkit-desktop", async ({
  page,
}) => {
  let requests = 0;
  const catalogNames: string[][] = [];
  let testFailure: { success: boolean; error?: string } | undefined;
  await page.route("**/api/openai/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as {
      tools: { name: string }[];
      input?: { type?: string; call_id?: string; output?: { text?: string }[] }[];
    };
    const verdict = body.input
      ?.find((item) => item.type === "function_call_output" && item.call_id === "run-tests")
      ?.output?.find((block) => typeof block.text === "string")?.text;
    if (verdict) testFailure = JSON.parse(verdict);
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
                  arguments: JSON.stringify({
                    testReasons: [
                      { test: "Impossible score", reason: "needs its score implementation." },
                    ],
                  }),
                },
              ]
            : requests === 2
              ? [
                  {
                    type: "function_call",
                    id: "run-tests",
                    call_id: "run-tests",
                    name: "run_game_tests",
                    arguments: '{"names":["Impossible score"]}',
                  },
                ]
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: testFailure?.error ?? "Tests complete." },
                    ],
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
  await expect(page.getByTestId("workspace-agent-panel")).toContainText("Applied automatically");
  await expect(page.getByTestId("agent-message")).toBeEnabled();
  await expect(page.getByTestId("workspace-agent-panel").getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  const committed = await documents(page);
  const tests = JSON.parse(committed["tests"]!);
  expect(tests.tests.some((entry: { name: string }) => entry.name === "Impossible score")).toBe(
    true,
  );
  const { tests: _oldTests, ...gameBefore } = before;
  const { tests: _newTests, ...gameAfter } = committed;
  expect(gameAfter).toEqual(gameBefore);

  await page.getByTestId("agent-message").fill("Run the committed Impossible score test");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => testFailure?.success).toBe(false);
  expect(testFailure!.error).toContain('0 game tests pass, 1 fail: "Impossible score"');
  expect(testFailure!.error).toContain("Expected score 99; observed 0.");
  await expect(page.getByTestId("workspace-agent-panel")).toContainText(testFailure!.error!);
  expect(await documents(page)).toEqual(committed);
  expect(catalogNames[0]).toContain("configure_launch");
  expect(catalogNames[1]).toEqual(catalogNames[0]);
  await page.screenshot({
    path: test.info().outputPath("committed-test-verdict.png"),
    animations: "disabled",
  });
});
for (const size of [{ width: 1440, height: 900 }]) {
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
      "Review asks before applying changes. Auto-approve applies game edits and new tests. Existing test edits need review.",
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
    await expect(page.getByRole("button", { name: "Chats", exact: true })).toBeVisible();
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
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
]) {
  test(`agent panel opaque header, one Agent title, secondary chat history and Escape ${size.width}`, async ({
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
    if (size.width > 600) {
      // The Agent sits beside the game and the editor, never over them.
      const drawer = (await page.getByTestId("agent-drawer").boundingBox())!;
      for (const part of [".shell-body--workspace > .play-area", ".workspace-editor"]) {
        const box = (await page.locator(part).boundingBox())!;
        expect(box.x + box.width, part).toBeLessThanOrEqual(drawer.x + 1);
      }
    }
    const header = panel.locator(".agent-panel__header");
    await expect(header).toBeVisible();

    const bg = await header.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");

    await expect(header.getByRole("heading", { name: "Agent", exact: true })).toHaveCount(1);
    await expect(header.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
    await header.getByRole("button", { name: "Chats", exact: true }).click();
    await expect(panel.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);
    await header.getByRole("button", { name: "Chats", exact: true }).click();

    const closeBtn = panel.getByRole("button", { name: "Close", exact: true });
    await expect(closeBtn).toBeVisible();

    await page.screenshot({ path: test.info().outputPath(`agent-panel-${size.width}-after.png`) });

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

test("a turn that stops without a change or a reply says so plainly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bodies: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    bodies.push(route.request().postData() ?? "");
    await route.fulfill(
      providerReply("openai", {
        id: `stopped-${bodies.length}`,
        output:
          bodies.length === 1
            ? [
                {
                  type: "function_call",
                  call_id: "write",
                  name: "write_logic",
                  arguments: JSON.stringify({
                    room: 1,
                    source: 'if (said("sparkle")) { print("Sparkle"); } return;',
                  }),
                },
                {
                  type: "function_call",
                  call_id: "finish",
                  name: "finish",
                  arguments: '{"testReasons":null}',
                },
              ]
            : bodies.length > 2
              ? [
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
                ]
              : [],
      }),
    );
  });
  await start(page, "openai", false);
  await page.getByTestId("agent-message").fill("Make LOOK sparkle");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page.getByTestId("agent-conversation").locator("article").last();
  // The notice names the failed write that stopped the turn, then the next step.
  await expect(reply).toContainText(
    /The agent stopped after this error: .*sparkle.* Ask again, or describe the change differently\./,
  );
  // The failed write reached the model with the refused finish before the turn ended.
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("Not finished: write_logic failed earlier in this batch");
  await expect(reply.getByTestId("agent-spent")).toHaveText("Usage not reported");
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect(page.getByTestId("agent-error")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("stopped-turn-1440.png") });
  // A later reply renders as safe Markdown.
  await page.getByTestId("agent-message").fill("Explain commands");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const markdown = page.locator(".agent-panel__markdown").last();
  await expect(markdown.locator("strong")).toHaveText("builder");
  await expect(markdown.locator("em")).toHaveText("player");
  await expect(markdown.locator("ul li")).toHaveCount(2);
  await expect(markdown.locator("ol li")).toHaveCount(2);
  await expect(markdown.locator("li code")).toHaveText("said()");
  await expect(markdown.locator("pre code")).toHaveText('print("Welcome");');
  await expect(markdown.locator("img")).toHaveCount(0);
  await expect(markdown).toContainText('<img src=x onerror="window.injected=true">');
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

test("an approved change after attaching reference art saves without pausing editing", async ({
  page,
}) => {
  const { encodePngRgb } = await import("../../src/picture/png.ts");
  await start(page, "stub", false);
  const panel = page.getByTestId("workspace-agent-panel");
  // The workspace composer offers reference art.
  await expect(panel.getByTestId("agent-attach-reference")).toBeVisible();
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
  await panel.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect
    .poll(async () => (await documents(page))["logic:1"])
    .toContain('said("look", "sign")');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const session = (
          window as unknown as {
            __AGI_PROJECT__: {
              getSession(): { flush(): Promise<void>; saveStatus(): { state: string } };
            };
          }
        ).__AGI_PROJECT__.getSession();
        await session.flush().catch(() => {});
        return session.saveStatus().state;
      }),
    )
    .toBe("saved");
  await expect(page.getByTestId("pending-edit-recovery")).toHaveCount(0);
  await expect(panel.getByTestId("agent-message")).toBeEnabled();
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
  await page.getByTestId("agent-review").getByRole("heading").first().scrollIntoViewIfNeeded();
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

test("an approved change shows at once in Create and again when Play resumes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const panel = page.getByTestId("workspace-agent-panel");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  // Play resumes its own run; keys reach that run once it owns the keyboard.
  await waitForGameInput(page);
  const input = page.getByTestId("input-line");
  if ((await textHook(page)).modal) {
    await input.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  }
  // Room 1's entry code places the hero at (80, 140); walk away from it, then stop.
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(95);
  // Entering a room keeps the hero's walking direction, so the hero must stand still.
  await expect
    .poll(async () => {
      const before = (await textHook(page)).egoX;
      // Let the game run a few cycles, then compare where the hero stands.
      await waitForCycles(page, 4);
      if ((await textHook(page)).egoX === before) return true;
      await page.keyboard.press("ArrowRight");
      return false;
    })
    .toBe(true);
  await openWorkspaceAgent(page);
  await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  // The change to Room 1's LOGIC re-runs its entry code in Create.
  await expect.poll(async () => (await textHook(page)).egoX).toBe(80);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  // Play resumes the walked-away moment, then re-enters Room 1 for the change.
  await expect(page.getByTestId("return-note")).toHaveText(
    "Room 1 started fresh with your changes.",
  );
  // The Agent is still open, so Play waits paused; closing it plays on.
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);
  await page.getByTestId("workspace-agent-panel").getByTestId("agent-panel-close").click();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(80);
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await page.screenshot({ path: test.info().outputPath("play-resumes-with-change-1440.png") });
});

/** A new Room 2, then one approved Agent turn that writes its LOGIC: the result offers Show. */
async function changeRoomTwo(page: Page, kind: "logic" | "picture" = "logic"): Promise<void> {
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `room-two-${requests}`,
        status: "completed",
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  call_id: "write",
                  name: kind === "logic" ? "write_logic" : "write_picture",
                  arguments: JSON.stringify({
                    room: 2,
                    source:
                      kind === "logic"
                        ? 'if (said("look")) { print("Room two."); } return;'
                        : "vis 3\nfill 1,1\nend\n",
                  }),
                },
                {
                  type: "function_call",
                  call_id: "finish",
                  name: "finish",
                  arguments: '{"testReasons":null}',
                },
              ]
            : [],
      }),
    );
  });
  await start(page, "openai", false);
  if (!(await page.getByTestId("parts-list").isVisible())) {
    // Mid widths fold Parts while the Agent is open and offer Parts beside it; phones swap panels.
    if (page.viewportSize()!.width <= 600)
      await page.getByTestId("workspace-agent-panel").getByTestId("agent-panel-close").click();
    await page.getByTestId("workspace-parts").click();
  }
  await addWorkspaceAction(page, "Add a room", { "Room name": "Grove" }, "world");
  await expect.poll(async () => (await documents(page))["logic:2"]).toBeDefined();
  // Play reaches the Meadow; Create opens on that moment, so Back has one to return to.
  if (await page.getByTestId("workspace-agent-panel").isVisible())
    await page.getByTestId("workspace-agent-panel").getByTestId("agent-panel-close").click();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/#create\//);
  await openWorkspaceAgent(page);
  await page.getByTestId("agent-message").fill("Give room two a look answer");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  await expect(page.getByTestId("agent-show-room")).toHaveText("Show Grove");
}

/** Hold the project's next save until `releaseSave` runs in the page. */
async function holdSave(page: Page): Promise<void> {
  await page.evaluate(() => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: { getSession(): { flush(): Promise<unknown> } };
      }
    ).__AGI_PROJECT__.getSession();
    const flush = session.flush.bind(session);
    const held = Promise.withResolvers<void>();
    session.flush = async () => {
      Object.assign(window, { saveHeld: true });
      await held.promise;
      return flush();
    };
    Object.assign(window, {
      releaseSave: () => {
        session.flush = flush;
        held.resolve();
      },
    });
  });
}

async function releaseSave(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { releaseSave(): void }).releaseSave());
}

test("Show Room takes the hero to a changed room, and Back returns", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await changeRoomTwo(page);
  const before = await textHook(page);
  expect(before.room).toBe(1);
  await page.getByTestId("agent-show-room").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await page.screenshot({ path: test.info().outputPath("show-room-1440.png") });
  await page.getByRole("button", { name: "Back to Meadow", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  expect((await textHook(page)).egoX).toBe(before.egoX);
});

for (const size of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Show Room visits an applied PICTURE change and Back returns ${size.width}${size.width === 390 ? " @phone" : ""}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await changeRoomTwo(page, "picture");
    const before = await textHook(page);
    expect(before.room).toBe(1);
    await page.screenshot({ path: test.info().outputPath(`picture-show-${size.width}.png`) });
    await page.getByTestId("agent-show-room").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(2);
    if (size.width === 390)
      await page.getByTestId("workspace-agent-panel").getByTestId("agent-panel-close").click();
    await page.getByRole("button", { name: "Back to Meadow", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    expect((await textHook(page)).egoX).toBe(before.egoX);
  });
}

// A Show clicked in Create answers that Create only: leaving it while the save
// finishes cancels the visit, so Play stays where the player was.
for (const back of [false, true]) {
  test(`a Show Room still saving when Play opens${back ? " and Create returns" : ""} goes nowhere`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await changeRoomTwo(page);
    await holdSave(page);
    await page.getByTestId("agent-show-room").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { saveHeld?: boolean }).saveHeld))
      .toBe(true);
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    await expect(page).toHaveURL(/#play\//);
    if (back) {
      await page.getByRole("radio", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/#create\//);
    }
    await releaseSave(page);
    await observe(page);
    expect((await textHook(page)).room).toBe(1);
    await expect(page.getByRole("button", { name: "Back to Meadow", exact: true })).toHaveCount(0);
  });
}

// An imported game keeps its LOGIC as compiled bytes. The review reads them as
// the LOGIC editor does, so an Agent edit that adds one line shows one line,
// not the whole file as new.
test("an Agent edit to an imported game's LOGIC shows only the changed lines", async ({ page }) => {
  const payload = assembleLogic(
    'if (isset(f5)) { display(5, 4, "A carrot patch."); } accept.input(); return;',
    { dictionary: new Map() },
  ).payload;
  const game = createContainer();
  game.putResource("logic", 0, payload);
  const zip = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: new Uint8Array(52) }]),
  );
  const before = disassembleLogic(payload, { profile: PROFILES["2.936"], dictionary: new Map() });
  const edited = `${before}display(6, 4, m1);\n`;
  expect(edited).not.toBe(before);
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `imported-${requests}`,
        status: "completed",
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  call_id: "write",
                  name: "write_logic",
                  arguments: JSON.stringify({ room: 0, source: edited }),
                },
                {
                  type: "function_call",
                  call_id: "finish",
                  name: "finish",
                  arguments: '{"testReasons":null}',
                },
              ]
            : [],
      }),
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "carrots.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);
  await openWorkspaceAgent(page);
  await page.getByTestId("agent-message").fill("Add a line about the carrots");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  const diff = page.getByTestId("agent-code-diff");
  await expect.poll(() => diff.locator(".line-insert").count()).toBe(1);
  expect(await diff.locator(".line-delete").count()).toBe(0);
});

test("approving before the source diff finishes has no unhandled rejection @webkit-desktop", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  await page.evaluate(async () => {
    const path = "/e2e/fixtures/uxPolish.ts";
    await (await import(path)).holdDiff();
  });
  await page.getByTestId("agent-message").fill("Add a welcome sign");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/e2e/fixtures/uxPolish.ts";
        return (await import(path)).diffPending();
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const path = "/e2e/fixtures/uxPolish.ts";
    await (await import(path)).approveBeforeDiff();
  });
  await expect(page.getByTestId("agent-review")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const size of [
  { width: 1063, height: 815 },
  { width: 390, height: 844 },
])
  test(`A red finish shows each failing test with the Agent's reason in the reply and in review, and a test change the creator asks for is reviewed (${size.width}px)`, async ({
    page,
  }) => {
    const lakeStart = {
      test: "Lake start",
      reason: "its room was deleted, so the test cannot start.",
    };
    const red = [
      { test: "Impossible score", reason: "the score handler is not written yet." },
      lakeStart,
    ];
    const change = [
      lakeStart,
      { test: "Impossible score", reason: "it now expects score 0, as you asked." },
    ];
    const lines = (reasons: typeof red) => reasons.map(({ test, reason }) => `${test}: ${reason}`);
    let requests = 0;
    await page.setViewportSize(size);
    await page.route("**/api/openai/v1/responses", async (route) => {
      requests++;
      const calls =
        requests === 1
          ? [
              {
                id: "pond",
                name: "propose_changes",
                input: {
                  label: "Blue meadow",
                  changes: [{ key: "picture:1", content: "vis 1\nfill 0,0\nend\n" }],
                },
              },
              { id: "finish", name: "finish", input: { testReasons: red } },
            ]
          : [
              {
                id: "expectation",
                name: "write_game_tests",
                input: {
                  mode: "merge",
                  names: null,
                  tests: [{ name: "Impossible score", room: 1, steps: [], expect: { score: 0 } }],
                },
              },
              { id: "finish", name: "finish", input: { testReasons: change } },
            ];
      await route.fulfill(
        providerReply("openai", {
          id: `reasons-${requests}`,
          status: "completed",
          output: calls.map((call) => ({
            type: "function_call",
            call_id: call.id,
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.input),
          })),
        }),
      );
    });
    await start(page, "openai", false);
    await page.evaluate(async () => {
      const session = (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): {
              model: {
                capture(): unknown;
                propose(base: unknown, label: string, changes: unknown[]): unknown;
              };
              submit(input: unknown): Promise<unknown>;
              flush(): Promise<unknown>;
            };
          };
        }
      ).__AGI_PROJECT__.getSession();
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Creator tests", [
          {
            key: "tests",
            content: JSON.stringify({
              format: "monotio.agi.tests.v2",
              tests: [
                { name: "Impossible score", room: 1, steps: [], expect: { score: 99 } },
                { name: "Lake start", room: 9, steps: [] },
              ],
            }),
          },
        ]),
        label: "Creator tests",
        origin: "guided",
        author: "creator",
      });
      await session.flush();
    });
    const conversation = page.getByTestId("agent-conversation");
    const review = page.getByTestId("agent-review-tests");
    const openReview = async () => {
      const button = conversation.getByRole("button", { name: "View changes", exact: true }).last();
      if (!(await review.isVisible())) await button.click();
      await expect(review).toBeVisible();
    };

    await page.getByTestId("agent-message").fill("Paint the meadow blue");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const reply = conversation.locator("article").last();
    await expect(reply).toContainText("2 tests fail: Impossible score, Lake start");
    await expect(reply.getByRole("listitem")).toHaveText(lines(red));
    await openReview();
    await expect(review).toContainText("2 tests fail: Impossible score, Lake start");
    await expect(review.getByRole("listitem")).toHaveText(lines(red));
    await expect(page.getByTestId("agent-art-review")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`red-finish-review-${size.width}.png`) });
    // A narrow layout shows the review in place of the chat; the reply is one step back.
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(reply.getByRole("listitem").first()).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`red-finish-reply-${size.width}.png`) });
    await openReview();
    await page.getByTestId("agent-reject").click();
    await expect(page.getByTestId("agent-review")).toHaveCount(0);

    await page
      .getByTestId("agent-message")
      .fill('Update "Impossible score" to expect score 0. I approve changing this expectation.');
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // Tests run as Apply would leave them, so the requested expectation already passes.
    const changeReply = conversation.locator("article").last();
    await expect(changeReply).toContainText("1 test fails: Lake start");
    await expect(changeReply.getByRole("listitem")).toHaveText(lines(change));
    await openReview();
    await expect(review.getByRole("listitem")).toHaveText(lines(change));
    await expect(page.getByTestId("agent-test-change")).toHaveText([
      'Changed expectation of "Impossible score"',
    ]);
    await expect(page.getByTestId("agent-test-change-detail").getByRole("row")).toHaveText([
      /Before\s*After/,
      /Steps\s*None\s*None/,
      /Checks\s*score 99\s*score 0/,
    ]);
    await page.screenshot({
      path: test.info().outputPath(`test-change-review-${size.width}.png`),
    });
    await page.getByTestId("agent-approve").click();
    await expect
      .poll(async () => JSON.parse((await documents(page))["tests"]!).tests[0].expect.score)
      .toBe(0);
  });

for (const width of [1440, 390])
  test(`Agent finish asks why each creator test it deleted or changed, and review shows the old and new expectation (${width}px)`, async ({
    page,
  }) => {
    let requests = 0;
    let refusal = "";
    await page.setViewportSize({ width, height: 950 });
    await page.route("**/api/openai/v1/responses", async (route) => {
      requests++;
      const body = route.request().postDataJSON() as {
        input?: { type?: string; call_id?: string; output?: { text?: string }[] }[];
      };
      const raw = body.input
        ?.find((entry) => entry.type === "function_call_output" && entry.call_id === "finish-red")
        ?.output?.find((entry) => entry.text)?.text;
      if (raw) refusal = JSON.parse(raw).error ?? "";
      const calls =
        requests === 1
          ? [
              {
                id: "remove",
                name: "write_game_tests",
                input: { mode: "remove", names: ["Open door"], tests: null },
              },
              {
                id: "weaken",
                name: "write_game_tests",
                input: {
                  mode: "merge",
                  names: null,
                  tests: [{ name: "Treasure", room: 1, steps: [], expect: { score: 0 } }],
                },
              },
              { id: "finish-red", name: "finish", input: { testReasons: null } },
            ]
          : [
              {
                id: "finish-reasons",
                name: "finish",
                input: {
                  testReasons: [
                    { test: "Open door", reason: "you asked to remove it." },
                    { test: "Treasure", reason: "you asked for score 0." },
                  ],
                },
              },
            ];
      await route.fulfill(
        providerReply("openai", {
          id: `red-review-${requests}`,
          status: "completed",
          output: calls.map((call) => ({
            type: "function_call",
            call_id: call.id,
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.input),
          })),
        }),
      );
    });
    await start(page, "openai", false);
    await page.getByRole("radio", { name: "Auto-approve", exact: true }).click();
    await page.evaluate(async () => {
      const session = (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): {
              model: {
                capture(): unknown;
                propose(base: unknown, label: string, changes: unknown[]): unknown;
              };
              submit(input: unknown): Promise<unknown>;
              flush(): Promise<unknown>;
            };
          };
        }
      ).__AGI_PROJECT__.getSession();
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Creator tests", [
          {
            key: "tests",
            content: JSON.stringify({
              format: "monotio.agi.tests.v2",
              tests: [
                { name: "Open door", room: 1, steps: [], expect: { score: 99 } },
                { name: "Treasure", room: 1, steps: [], expect: { score: 99 } },
              ],
            }),
          },
        ]),
        label: "Creator tests",
        origin: "guided",
        author: "creator",
      });
      await session.flush();
    });
    const before = await documents(page);
    await page.getByTestId("agent-message").fill("Propose the requested test edits for review");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("agent-review")).toBeVisible();
    expect(refusal).toBe(
      'Not finished: give testReasons for "Open door", "Treasure". Each red test needs a reason it stays red, and each existing test you changed or deleted needs a reason for the change.',
    );
    // Tests run as Apply would leave them: one test is left, and its weaker check passes.
    await expect(page.getByTestId("workspace-agent-panel")).toContainText("1 test passes.");
    await expect(page.getByTestId("agent-review-tests").getByRole("listitem")).toHaveText([
      "Open door: you asked to remove it.",
      "Treasure: you asked for score 0.",
    ]);
    await expect(page.getByTestId("agent-test-change")).toHaveText([
      'Deleted test "Open door"',
      'Changed expectation of "Treasure"',
    ]);
    await expect(page.getByTestId("agent-test-change-detail").getByRole("row").last()).toHaveText(
      /Checks\s*score 99\s*score 0/,
    );
    expect(await documents(page)).toEqual(before);
    await page.screenshot({ path: test.info().outputPath(`test-review-changes-${width}.png`) });
  });
