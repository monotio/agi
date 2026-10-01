import { test, expect } from "./test.ts";
import { isolateStorage, textHook, configureAi } from "./engineProbe.ts";
import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
async function start(page: Page) {
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
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("part-room:1:logic").click();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
}
async function snapshot(page: Page, name: string) {
  const directory = process.env["AGI_AGENT_SHOTS"];
  if (directory) {
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/${name}.png` });
  }
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
    await snapshot(page, `review-${size.width}x${size.height}`);
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
    await page.getByTestId("agent-auto-approve").check();
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
    await snapshot(page, `auto-approve-${size.width}x${size.height}`);
    await page.getByTestId("agent-message").focus();
    await page.keyboard.press("ControlOrMeta+n");
    await expect(page.getByRole("button", { name: "Chats", exact: true })).toHaveText("New chat ▾");
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: "Add a welcome sign", exact: true }).click();
    await expect(page.getByRole("button", { name: "Undo this", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo this", exact: true }).click();
    await expect.poll(async () => (await documents(page))["picture:1"]).toBe(before["picture:1"]);
  });
}
