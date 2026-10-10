import { expect, test } from "./test.ts";
import { configureAi, isolateStorage, openWorkspaceAgent } from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { Page } from "@playwright/test";

async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Spend proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await configureAi(page, {
    provider: "openai",
    key: "test-placeholder",
    model: "gpt-6-sol",
    budget: 5,
  });
}

for (const size of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`agent reports completed task spend ${size.width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    await openWorkspaceAgent(page);
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    expect(await panel.innerText()).not.toContain("$");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/openai/v1/responses", async (route) => {
      await pending;
      await route.fulfill(
        providerReply("openai", {
          id: "spent",
          usage: { input_tokens: 10000, output_tokens: 5000 },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "The room is ready." }],
            },
          ],
        }),
      );
    });
    try {
      await page.getByTestId("agent-message").fill("Describe this room.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("agent-stop")).toBeVisible();
      await expect(page.getByTestId("agent-spent")).toBeVisible();
      await expect(page.getByTestId("agent-spent")).toHaveText("$5 budget · usage pending");
      release();
      await expect(page.getByTestId("agent-message")).toBeEnabled();
      await page.screenshot({
        path: test.info().outputPath(`spent-agent-${size.width}.png`),
        animations: "disabled",
      });
      await expect(page.getByTestId("agent-spent")).toBeVisible();
      await expect(page.getByTestId("agent-spent")).toHaveText("$0.07 / $5 spent");
      await panel.getByRole("button", { name: "Agent settings", exact: true }).click();
      await expect(panel.getByRole("link", { name: "Provider usage", exact: true })).toBeVisible();
    } finally {
      release();
    }
  });

  test(`image reports completed request spend ${size.width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/test-images/v1/images/generations", async (route) => {
      await pending;
      const pixels = new Uint8Array(1536 * 1024 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 170, 170, 255], i);
      await route.fulfill({
        json: {
          data: [{ b64_json: Buffer.from(encodePngRgba(1536, 1024, pixels)).toString("base64") }],
          usage: {
            input_tokens_details: { text_tokens: 2000, image_tokens: 3000 },
            output_tokens: 1200,
          },
        },
      });
    });
    if (size.width === 390) await page.getByTestId("workspace-parts").click();
    await page.getByTestId("part-room:1:picture:1").click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const form = page.getByTestId("generate-form");
    await expect(form).toBeVisible();
    const generator = page.locator(".generate");
    await expect(generator).toBeVisible();
    expect(await generator.innerText()).not.toContain("$");
    await expect(page.getByTestId("generate-spent")).toBeHidden();
    try {
      await page.getByTestId("generate-prompt").fill("A quiet clearing");
      await page.getByTestId("generate-review").click();
      await expect(page.getByTestId("generate-flight")).toBeVisible();
      await expect(page.getByTestId("generate-spent")).toBeVisible();
      await expect(page.getByTestId("generate-spent")).toHaveText("$0.00 of $5 spent");
      await page.screenshot({
        path: test.info().outputPath(`spent-image-pending-${size.width}.png`),
        animations: "disabled",
      });
      release();
      await expect(page.getByTestId("generate-offer")).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`spent-image-${size.width}.png`),
        animations: "disabled",
      });
      await expect(page.getByTestId("generate-spent")).toBeVisible();
      await expect(page.getByTestId("generate-spent")).toHaveText("$0.07 of $5 spent");
      await expect(
        page
          .getByTestId("generate-offer")
          .getByRole("link", { name: "See your usage", exact: true }),
      ).toBeVisible();
    } finally {
      release();
    }
  });
}

for (const action of ["Continue", "Stop"] as const) {
  test(`image budget ${action} keeps the returned image @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width: 1063, height: 815 });
    await start(page);
    let requests = 0;
    await page.route("**/api/test-images/v1/images/generations", async (route) => {
      requests++;
      const pixels = new Uint8Array(1536 * 1024 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([0, 170, 170, 255], i);
      await route.fulfill({
        json: {
          data: [{ b64_json: Buffer.from(encodePngRgba(1536, 1024, pixels)).toString("base64") }],
          usage: {
            input_tokens_details: { text_tokens: 0, image_tokens: 0 },
            output_tokens: 170_667,
          },
        },
      });
    });
    await page.getByTestId("part-room:1:picture:1").click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await page.getByTestId("generate-prompt").fill("A quiet clearing");
    await page.getByTestId("generate-review").click();
    await expect(page.getByTestId("generate-offer")).toBeVisible();
    const pause = page.getByTestId("generate-budget");
    await expect(pause).toBeVisible();
    await expect(page.getByTestId("generate-spent")).toBeVisible();
    await expect(page.getByTestId("generate-spent")).toHaveText("$5.12 of $5 spent");
    expect(requests).toBe(1);
    const preview = page.getByTestId("generate-preview");
    await expect(preview).toBeVisible();
    const image = await preview.getAttribute("src");
    await pause.getByRole("button", { name: action, exact: true }).click();
    await expect(pause).toBeHidden();
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("src", image!);
    await expect(page.getByTestId("generate-spent")).toHaveText(
      `$5.12 of $${action === "Continue" ? "10" : "5"} spent`,
    );
    expect(requests).toBe(1);
  });
}

test("a failed task keeps its already reported spend visible @webkit-desktop", async ({ page }) => {
  await start(page);
  await openWorkspaceAgent(page);
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    if (requests > 1) {
      await route.fulfill({
        status: 400,
        json: { error: { message: "Injected provider failure" } },
      });
      return;
    }
    await route.fulfill(
      providerReply("openai", {
        id: "paid-inspection",
        usage: { input_tokens: 10000, output_tokens: 5000 },
        output: [
          {
            type: "function_call",
            call_id: "read",
            name: "read_document",
            arguments: JSON.stringify({ key: "logic:1", offset: null, limit: null }),
          },
        ],
      }),
    );
  });
  await page.getByTestId("agent-message").fill("Inspect the room");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-error")).toContainText("Injected provider failure");
  await expect(page.getByTestId("agent-stop")).toHaveCount(0);
  await expect(page.getByTestId("agent-spent")).toHaveText("$0.07+ / $5 spent");
});

test("final conversation save keeps a single spend while task controls are visible @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await openWorkspaceAgent(page);
  await page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const original = session.flush.bind(session);
    const gate = Promise.withResolvers<void>();
    Reflect.set(window, "releaseFinalSave", gate.resolve);
    session.flush = async () => {
      if (session.chats().chats.some((chat) => chat.messages.some((message) => message.spend))) {
        Reflect.set(window, "finalSaveHeld", true);
        await gate.promise;
      }
      await original();
    };
  });
  await page.route("**/api/openai/v1/responses", async (route) => {
    await route.fulfill(
      providerReply("openai", {
        id: "saved-spend",
        usage: { input_tokens: 10000, output_tokens: 5000 },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The room is ready." }],
          },
        ],
      }),
    );
  });
  await page.getByTestId("agent-message").fill("Describe this room.");
  await page.getByTestId("agent-send").click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "finalSaveHeld"))).toBe(true);
  await expect(page.getByTestId("agent-conversation")).toContainText("The room is ready.");
  await expect(page.getByTestId("agent-task-controls")).toBeVisible();
  await expect(page.getByTestId("agent-spent")).toHaveCount(1);
  await expect(page.getByTestId("agent-spent")).toHaveText("$0.07 / $5 spent");
  await page.evaluate(() => (Reflect.get(window, "releaseFinalSave") as () => void)());
  await expect(page.getByTestId("agent-task-controls")).toBeHidden();
  await expect(page.getByTestId("agent-spent")).toHaveCount(1);
  await expect(page.getByTestId("agent-conversation").getByTestId("agent-spent")).toHaveText(
    "$0.07 / $5 spent",
  );
});

test("a background task retains foreground reply spend @webkit-desktop", async ({ page }) => {
  await start(page);
  await openWorkspaceAgent(page);
  let release!: () => void;
  let requests = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    if (requests > 1) await gate;
    await route.fulfill(
      providerReply("openai", {
        id: `background-${requests}`,
        usage: { input_tokens: 10000, output_tokens: 5000 },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: requests === 1 ? "Earlier paid reply." : "Background ready.",
              },
            ],
          },
        ],
      }),
    );
  });
  await page.getByTestId("agent-message").fill("Describe this room.");
  await page.getByTestId("agent-send").click();
  const priorSpend = page.getByTestId("agent-conversation").getByTestId("agent-spent");
  await expect(priorSpend).toHaveText("$0.07 / $5 spent");
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const original = session.flush.bind(session);
    const finalGate = Promise.withResolvers<void>();
    Reflect.set(window, "releaseBackgroundSave", finalGate.resolve);
    session.flush = async () => {
      if (
        session
          .chats()
          .chats.some((chat) =>
            chat.messages.some((message) => message.text === "Background ready." && message.spend),
          )
      ) {
        Reflect.set(window, "backgroundSaveHeld", true);
        await finalGate.promise;
      }
      await original();
    };
    const path = "/src/agent/workspaceAgent.ts";
    const { borrowWorkspaceAgent } = await import(path);
    const agent = borrowWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => {
        throw new Error("The existing conversation owner must be borrowed");
      },
    });
    Reflect.set(window, "backgroundWork", agent.background("Next room", "Inspect the next room"));
  });
  try {
    await expect(page.getByTestId("agent-task-controls")).toBeVisible();
    await expect(priorSpend).toBeVisible();
    await expect(priorSpend).toHaveText("$0.07 / $5 spent");
    release();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "backgroundSaveHeld")))
      .toBe(true);
    await expect(priorSpend).toBeVisible();
    expect(requests).toBe(2);
    // Background room work shares the budget: two $0.07 replies, one in each task.
    await expect(page.getByTestId("agent-task-controls").getByTestId("agent-spent")).toHaveText(
      "$0.14 / $5 spent",
    );
    await expect(page.getByTestId("agent-spent")).toHaveCount(2);
    await page.evaluate(() => (Reflect.get(window, "releaseBackgroundSave") as () => void)());
    await page.evaluate(() => Reflect.get(window, "backgroundWork"));
    await expect(page.getByTestId("agent-task-controls")).toBeHidden();
    await expect(priorSpend).toHaveText("$0.07 / $5 spent");
  } finally {
    release();
    await page.evaluate(() => (Reflect.get(window, "releaseBackgroundSave") as () => void)());
  }
});
