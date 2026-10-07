import { expect, test } from "./test.ts";
import {
  configureAi,
  isolateStorage,
  openCreateAdventure,
  openSavedGameDetails,
  savedGameCard,
  textHook,
  waitForRoom,
  workspaceSaved,
  workspaceUpdated,
} from "./engineProbe.ts";
import { openWorkspaceLogic, workspaceDocument } from "./workspaceShared.ts";

const label = "AI makes new rooms when the hero walks into one";
for (const width of [1063, 1440, 390]) {
  test(`room setting and quiet Game state ${width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1063 ? 815 : width === 390 ? 844 : 900 });
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-title").fill("Room setting");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    await waitForRoom(page, 1);
    await workspaceUpdated(page);
    if (width === 390) await page.getByTestId("workspace-parts").click();
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      scale: "css",
      path: test.info().outputPath(`parts-${width}.png`),
    });
    await expect(page.getByTestId("part-state")).toBeVisible();
    await page.getByTestId("part-state").click();
    const state = page.getByTestId("workspace-state");
    await expect(state).toBeVisible();
    const row = state.locator("tr").filter({ hasText: "chime_done" });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("Set:");
    await expect(row).not.toContainText("Checked:");
    await page.screenshot({
      animations: "disabled",
      scale: "css",
      path: test.info().outputPath(`state-${width}.png`),
    });
    await row.getByRole("button", { name: "Actions for chime_done", exact: true }).click();
    await page.getByRole("menuitem", { name: "Find references", exact: true }).click();
    const references = state.getByTestId("binding-details");
    await expect(references).toBeVisible();
    await references.getByText("Set: LOGIC 1", { exact: true }).scrollIntoViewIfNeeded();
    await expect(references.getByText("Set: LOGIC 1", { exact: true })).toBeVisible();
    await expect(references.getByText("Checked: nowhere yet", { exact: true })).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      scale: "css",
      path: test.info().outputPath(`state-details-${width}.png`),
    });
    await references.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTestId("workspace-more").click();
    await page.getByRole("menuitem", { name: "Details…", exact: true }).click();
    const createDetails = page.getByTestId("workspace-game-details");
    await expect(createDetails).toBeVisible();
    await expect(createDetails.getByRole("switch", { name: label, exact: true })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.screenshot({
      animations: "disabled",
      scale: "css",
      path: test.info().outputPath(`create-details-${width}.png`),
    });
    await createDetails.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTestId("btn-exit").click();
    await openSavedGameDetails(savedGameCard(page, "Room setting"));
    const details = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "Room setting", exact: true }) });
    await expect(details).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      scale: "css",
      path: test.info().outputPath(`details-${width}.png`),
    });
    const setting = details.getByRole("switch", { name: label, exact: true });
    await expect(setting).toBeVisible();
    await expect(setting).toHaveAttribute("aria-checked", "false");
    await setting.click();
    await expect(setting).toBeEnabled();
    await expect(setting).toHaveAttribute("aria-checked", "true");
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    const reopened = await openSavedGameDetails(savedGameCard(page, "Room setting"));
    const persisted = reopened.getByRole("switch", { name: label, exact: true });
    await expect(persisted).toBeVisible();
    await expect(persisted).toHaveAttribute("aria-checked", "true");
    await persisted.click();
    await expect(persisted).toBeEnabled();
    await expect(persisted).toHaveAttribute("aria-checked", "false");
  });
}

test("Create with AI edits room 2 while room 3 is unbuilt and seals its exits @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await openCreateAdventure(page);
  await page.getByTestId("template-mop-jockey").click();
  await page.getByTestId("local-create-title").fill("Growing rooms");
  await page.getByTestId("boot-game").click();
  await waitForRoom(page, 1);
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await input.focus();
  await page.keyboard.press("Enter");
  await input.fill("east");
  await input.press("Enter");
  await waitForRoom(page, 2);
  await input.focus();
  await page.keyboard.press("Enter");
  await openWorkspaceLogic(page, 2);
  await workspaceUpdated(page);
  const before = await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    return monaco.editor
      .getEditors()
      .find((editor) => editor.getDomNode()?.closest('[data-testid="workspace-logic-editor"]'))
      ?.getValue();
  });
  expect(before).toContain("new.room(3)");
  await page.getByTestId("workspace-agent").click();
  const agent = page.getByTestId("workspace-agent-panel");
  await expect(agent).toBeVisible();
  await page.getByTestId("agent-message").fill("Add a welcome sign");
  await agent.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-review")).toBeVisible();
  await page.getByTestId("agent-approve").click();
  await expect(page.getByTestId("agent-review")).toBeHidden();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:2")).toContain("Welcome sign");
  expect(await workspaceDocument(page, "logic:2")).toContain("new.room(3)");
  await agent.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("workspace-more").click();
  await page.getByRole("menuitem", { name: "Details…", exact: true }).click();
  const details = page.getByTestId("workspace-game-details");
  await expect(details).toBeVisible();
  const setting = details.getByRole("switch", { name: label, exact: true });
  await expect(setting).toHaveAttribute("aria-checked", "true");
  await setting.click();
  await expect(setting).toBeEnabled();
  await expect(setting).toHaveAttribute("aria-checked", "false");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
  await page.getByTestId("workspace-status-problems").click();
  const problems = page.getByTestId("workspace-problems");
  await expect(problems).toBeVisible();
  await expect(problems).toContainText("LOGIC 3 is absent");
  await expect(problems).not.toContainText("target is unresolved");
  await page.getByTestId("workspace-more").click();
  await page.getByRole("menuitem", { name: "Details…", exact: true }).click();
  await expect(details).toBeVisible();
  await setting.click();
  await expect(setting).toBeEnabled();
  await expect(setting).toHaveAttribute("aria-checked", "true");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(problems).toBeVisible();
  await expect(problems).toHaveText("Everything builds.");
  expect((await textHook(page)).room).toBe(2);
});
