import { providerReply } from "../../test/provider-stream.ts";
import { test, expect } from "./test.ts";
import {
  isolateStorage,
  textHook,
  configureAi,
  openWorkspaceAgent,
  openWorkspacePicture,
} from "./engineProbe.ts";
import { openWorkspaceLogic } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";

async function startStarter(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

async function editorBox(page: Page) {
  const editor = page.getByTestId("workspace-editor");
  await expect(editor).toBeVisible();
  return (await editor.boundingBox())!;
}

for (const reopened of [false, true]) {
  test(`closing Agent during a held opening resumes Play${reopened ? " and preserves the replacement opening" : ""} @webkit-desktop`, async ({
    page,
  }) => {
    await startStarter(page);
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    await page.evaluate(() => {
      const probe = window as unknown as {
        __AGI_PROJECT__: { getWorker(): Worker };
        __AGI_E2E_RELEASE_OPENING__: () => void;
        __AGI_E2E_OPENING_HELD__: boolean;
      };
      const worker = probe.__AGI_PROJECT__.getWorker();
      const post = worker.postMessage;
      let held: WorkerInbound | undefined;
      worker.postMessage = function (message: WorkerInbound, transfer) {
        if (message.type === "state" && held === undefined) {
          held = message;
          probe.__AGI_E2E_OPENING_HELD__ = true;
          worker.postMessage = post;
          return;
        }
        post.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer);
      };
      probe.__AGI_E2E_RELEASE_OPENING__ = () => {
        if (held !== undefined) post.call(worker, held);
        held = undefined;
      };
    });
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __AGI_E2E_OPENING_HELD__: boolean }).__AGI_E2E_OPENING_HELD__,
        ),
      )
      .toBe(true);
    await panel.getByTestId("agent-panel-close").click();
    await expect(panel).toBeHidden();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    if (reopened) {
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("agent-message")).toBeEnabled();
    }
    await page.evaluate(() =>
      (
        window as unknown as { __AGI_E2E_RELEASE_OPENING__: () => void }
      ).__AGI_E2E_RELEASE_OPENING__(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __AGI_STATE__: { powerUp: { busy: boolean } } }).__AGI_STATE__
              .powerUp.busy,
        ),
      )
      .toBe(false);
    if (reopened) {
      await expect(panel).toBeVisible();
      await expect.poll(async () => (await textHook(page)).paused).toBe(true);
      await panel.getByTestId("agent-panel-close").click();
    }
    await expect(panel).toBeHidden();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    const cycle = (await textHook(page)).cycle;
    await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  });
}

for (const ending of ["closed", "reopened", "create-route"] as const) {
  const reopened = ending === "reopened";
  test(`${ending === "create-route" ? "a Create hash route during Agent module loading releases initialization" : `closing Agent before its module loads retires the opening${reopened ? " while a newer opening succeeds" : ""}`} @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/src/authoring/useAuthoringController.ts*", async (route) => {
      requested = true;
      await held;
      await route.continue();
    });
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await page.getByTestId("catalog-play-adventure-department").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    if (ending === "create-route") {
      await page.evaluate(() => {
        location.hash = location.hash.replace(/^#play\//, "#create/");
      });
      await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    } else {
      await panel.getByTestId("agent-panel-close").click();
      await expect(panel).toBeHidden();
      if (reopened) {
        await page.getByRole("button", { name: "Agent", exact: true }).click();
        await expect(panel).toBeVisible();
      }
    }
    release();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __AGI_STATE__: { powerUp: { busy: boolean } } }).__AGI_STATE__
              .powerUp.busy,
        ),
      )
      .toBe(false);
    if (reopened || ending === "create-route") {
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("agent-message")).toBeEnabled();
      await panel.getByTestId("agent-panel-close").click();
    }
    await expect(panel).toBeHidden();
    if (ending === "create-route")
      await page.getByRole("radio", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  });
}

test("failed Agent module loading releases initialization and shows recovery @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  const load = Promise.withResolvers<void>();
  let requested = false;
  await page.route("**/src/authoring/useAuthoringController.ts*", async (route) => {
    requested = true;
    await load.promise;
    await route.abort();
  });
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  load.resolve();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __AGI_STATE__: { powerUp: { busy: boolean } } }).__AGI_STATE__
            .powerUp.busy,
      ),
    )
    .toBe(false);
  await expect(panel).toContainText("Agent could not load. Reload the page and try again.");
  await panel.getByTestId("agent-panel-close").click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
});

test("agent drawer overlays the workspace without narrowing the editor in both arrangements @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startStarter(page);
  await openWorkspaceLogic(page);
  const panel = page.getByTestId("workspace-agent-panel");

  const layout = page.getByTestId("workspace-layout");
  await expect(layout).toBeVisible();
  for (const arrangement of ["Side by side", "Stacked"]) {
    const pressed = arrangement === "Side by side" ? "true" : "false";
    if ((await layout.getAttribute("aria-pressed")) !== pressed) await layout.click();
    await expect(layout).toHaveAttribute("aria-pressed", pressed);
    const before = await editorBox(page);
    await openWorkspaceAgent(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("agent-message")).toBeFocused();
    const after = await editorBox(page);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    // The drawer hugs the right edge over the workspace, opaque.
    const drawer = page.locator(".agent-drawer");
    await expect
      .poll(async () => {
        const bounds = await drawer.boundingBox();
        return bounds ? bounds.x + bounds.width : null;
      })
      .toBe(1440);
    const box = (await drawer.boundingBox())!;
    expect(box.x + box.width).toBe(1440);
    expect(box.width).toBeGreaterThanOrEqual(400);
    const bg = await drawer.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    await page.screenshot({
      path: test.info().outputPath(`drawer-${arrangement.replaceAll(" ", "-")}-1440.png`),
    });
    await panel.getByTestId("agent-panel-close").click();
    await expect(panel).toBeHidden();
  }

  // Esc inside the drawer closes it; Esc in the game stays with the game.
  await openWorkspaceAgent(page);
  await panel.getByTestId("agent-message").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await openWorkspaceAgent(page);
  await expect(panel).toBeVisible();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
});

test("the drawer is full width on a phone @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startStarter(page);
  await openWorkspaceAgent(page);
  const drawer = page.locator(".agent-drawer");
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  const box = (await drawer.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
});

test("a blank project has a working agent drawer @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-blank").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.locator(".screen").getByText("Nothing to play yet.")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Agent", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("agent-message")).toBeFocused();

  // Without a key the drawer says how to connect one, on the existing settings path.
  await expect(panel).toContainText("Connect your AI provider in Settings to start a task.");
  await panel.getByTestId("agent-open-ai-settings").click();
  const dialog = page.getByTestId("ai-settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("provider-select").selectOption("stub");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();

  // With a provider connected the blank project answers through the drawer.
  const composer = panel.getByTestId("agent-message");
  await expect(composer).toBeEnabled();
  await composer.fill("Build a meadow room");
  const send = panel.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(panel.locator(".agent-panel__message").last()).toContainText(
    "The project is ready for a task.",
  );
  await page.screenshot({ path: test.info().outputPath("drawer-blank-1440.png") });

  // Esc with focus in the drawer closes it; × closes it too.
  await composer.press("Escape");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(panel).toContainText("Build a meadow room");
  await panel.getByTestId("agent-panel-close").click();
  await expect(panel).toBeHidden();
});

for (const boundary of ["reopened", "closed", "departed"] as const) {
  test(`a blank agent's first room follows its ${boundary} stage owner @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-blank").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    const stage = page.getByTestId("empty-project-stage");
    await expect(stage).toBeVisible();
    const hash = new URL(page.url()).hash;
    const toggle = page.getByRole("button", { name: "Agent", exact: true });
    await toggle.click();
    const composer = page.getByTestId("agent-message");
    await expect(composer).toBeEnabled();
    await composer.fill("Keep this first-room draft");
    if (boundary === "reopened") {
      await composer.press("Escape");
      await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
      await toggle.click();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep this first-room draft");
    }
    await page.evaluate(async (hold) => {
      const { emptyProject } = await import("/src/home/emptyProjectRoute.ts");
      const { emptyStageSession } = await import("/src/home/emptyStageSession.ts");
      const { emptyWorkspaceChanges } = await import("/src/studio/workspace/emptyWorkspace.ts");
      const session = await emptyStageSession(emptyProject.value!);
      if (!session) throw new Error("Blank agent session missing");
      const gate = Promise.withResolvers<void>();
      const audit = { held: false, release: () => gate.resolve() };
      Reflect.set(window, "blankAgentCommit", audit);
      if (hold) {
        const flush = session.flush.bind(session);
        session.flush = async () => {
          await flush();
          audit.held = true;
          await gate.promise;
        };
      }
      const result = await session.submit({
        proposal: session.model.propose(
          session.model.capture(),
          "First room",
          emptyWorkspaceChanges("room"),
        ),
        label: "First room",
        origin: "agent",
        author: "agent",
      });
      if (result.status !== "committed") throw new Error(`First room refused: ${result.status}`);
    }, boundary !== "reopened");
    if (boundary !== "reopened") {
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "blankAgentCommit").held))
        .toBe(true);
      await composer.press("Escape");
      await expect(page.getByTestId("workspace-agent-panel")).toBeHidden();
      if (boundary === "departed") {
        await stage.getByTestId("btn-exit").click();
        await expect(stage).toBeHidden();
      }
      await page.evaluate(() => Reflect.get(window, "blankAgentCommit").release());
    }
    if (boundary === "departed") {
      // The complete saved edit remains available without reopening a departed stage.
      await expect(page).toHaveURL(/\/$/);
      expect((await textHook(page)).profile).toBeNull();
    } else {
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect(stage).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`${hash}$`));
    }
    expect(
      await page.evaluate(
        async (id) => {
          const storage = await import("/src/project/gameStorage.ts");
          return (await storage.loadAuthoredGame(id as never))?.workspace?.documents.map(
            (document) => document.key,
          );
        },
        decodeURIComponent(hash.slice("#create/".length)),
      ),
    ).toEqual(expect.arrayContaining(["logic:0", "logic:1"]));
  });
}

test("drawer initialization preserves a new editor focus @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startStarter(page);
  const logic = await openWorkspaceLogic(page);
  let waiting = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.exposeFunction("holdAgentFlush", async () => {
    waiting = true;
    await held;
  });
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const flush = session.flush.bind(session);
    session.flush = async () => {
      await flush();
      await (window as unknown as { holdAgentFlush(): Promise<void> }).holdAgentFlush();
      session.flush = flush;
    };
  });
  try {
    await openWorkspaceAgent(page);
    await expect.poll(() => waiting).toBe(true);
    await expect(page.getByTestId("agent-message")).toBeDisabled();
    await logic
      .locator(".view-line")
      .nth(2)
      .click({ position: { x: 24, y: 8 } });
    await expect(page.getByTestId("agent-context-chip")).toContainText("LOGIC 1 · line 3");
    release();
    await expect(page.getByTestId("agent-message")).toBeEnabled();
    await expect(logic.locator("textarea.inputarea")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("agent-context-chip")).toContainText("LOGIC 1 · line 4");
  } finally {
    release();
  }
});

test("the context chip follows selection and can be removed @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  const prompts: string[] = [];
  await page.route("**/api/openai/v1/responses", async (route) => {
    prompts.push(route.request().postData() ?? "");
    await route.fulfill(
      providerReply("openai", {
        id: `chip-${prompts.length}`,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Answer ${prompts.length}.` }],
          },
        ],
      }),
    );
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  // LOGIC: the chip names the cursor line and follows it.
  const logic = await openWorkspaceLogic(page);
  await openWorkspaceAgent(page);
  const chip = page.getByTestId("agent-context-chip");
  await logic
    .locator(".view-line")
    .nth(2)
    .click({ position: { x: 24, y: 8 } });
  await expect(chip).toContainText("LOGIC 1 · line 3");
  await page.keyboard.press("ArrowDown");
  await expect(chip).toContainText("LOGIC 1 · line 4");

  // Dismissed: the next ask is about the whole game; a new selection brings the chip back.
  const messages = page.getByTestId("workspace-agent-panel").locator(".agent-panel__message");
  const composer = page.getByTestId("agent-message");
  await chip.getByRole("button", { name: "Remove context", exact: true }).click();
  await expect(chip).toHaveCount(0);
  let sent = prompts.length;
  await composer.fill("What is here?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages.last()).toContainText(`Answer ${sent + 1}.`);
  expect(prompts.slice(sent).join("\n")).not.toContain("Selection: LOGIC 1");
  await logic
    .locator(".view-line")
    .nth(5)
    .click({ position: { x: 24, y: 8 } });
  await expect(chip).toContainText("LOGIC 1 · line 6");
  sent = prompts.length;
  await composer.fill("And this line?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => prompts.length).toBeGreaterThan(sent);
  await expect(messages.last()).toContainText(`Answer ${sent + 1}.`);
  expect(prompts.slice(sent).join("\n")).toContain("Selection: LOGIC 1 · line 6");

  // PICTURE: the chip names the selected item (keyboard selection: the drawer covers the list).
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(chip).toContainText("PICTURE 1 ·");
});
