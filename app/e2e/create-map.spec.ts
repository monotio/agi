import { test, expect } from "./test.ts";
import { isolateStorage, textHook, configureAi } from "./engineProbe.ts";
import { VOCABULARY } from "../../src/vocabulary.ts";

test("Create map opens from the top bar and quick open; room picks open PICTURE", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const map = page.getByTestId("world-map");
  await page.getByTestId("btn-world-map").click();
  await expect(map).toBeVisible();
  await expect(map.getByTestId("btn-world-plan")).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: test.info().outputPath("create-map-1440.png"),
    animations: "disabled",
  });
  await map.getByTestId("map-node-1").click();
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(page.getByTestId("workspace-editor")).toContainText("PICTURE 1");
  await page.keyboard.press("ControlOrMeta+p");
  const chooser = page.getByRole("dialog");
  await chooser.getByRole("combobox").fill("Open map");
  await chooser.getByRole("option", { name: /Open map/ }).click();
  await expect(map).toBeVisible();
  await map.getByTestId("world-all-rooms").click();
  await map.getByTestId("map-room-1").getByRole("button").first().click();
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId("room-studio")).toBeVisible();
});

test("Play uses the shared Agent name and retains hint mode", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const button = page.getByTestId("menu-assistant");
  await expect(button).toHaveText(VOCABULARY.agent.label);
  await expect(button).toHaveAttribute("title", "Ask questions or get hints about this game.");
  await button.click();
  const drawer = page.getByTestId("workspace-agent-panel");
  await expect(drawer.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
  await expect(drawer.getByRole("heading")).toHaveAttribute(
    "title",
    "Ask questions or get hints about this game.",
  );
  await expect(drawer.getByTestId("agent-read-only")).toHaveText("Read only");
  await drawer.getByTestId("agent-message").fill("Give me a hint");
  await drawer.getByTestId("agent-send").click();
  await expect(drawer.getByTestId("agent-conversation")).toContainText("Give me a hint");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});
