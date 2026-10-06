import { expect, test } from "./test.ts";
import { isolateStorage, textHook, workspaceUpdated } from "./engineProbe.ts";
import { openStoredWorkspace } from "./workspaceShared.ts";

test("version names are visible, survive reload, rename and clear", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Named history");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await workspaceUpdated(page);
  await page.getByTestId("workspace-saved").click();
  const history = page.getByTestId("workspace-history");
  await history.getByLabel("Version name", { exact: true }).fill("Opening scene");
  await history.getByRole("button", { name: "Name this version", exact: true }).click();
  await expect(history.locator(".workspace-history__name")).toHaveText("Opening scene");
  await expect(history.locator(".workspace-history__label")).toHaveText("Opened");
  await workspaceUpdated(page);
  await page.reload();
  await page.goto("/");
  await openStoredWorkspace(page, "Named history");
  await page.getByTestId("workspace-saved").click();
  await expect(history.locator(".workspace-history__name")).toHaveText("Opening scene");
  await history.getByRole("button", { name: "Rename Opening scene", exact: true }).click();
  await history.getByLabel("Version name", { exact: true }).fill("First room");
  await history.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(history.locator(".workspace-history__name")).toHaveText("First room");
  await history.getByRole("button", { name: "Clear First room", exact: true }).click();
  await expect(history.locator(".workspace-history__name")).toHaveCount(0);
  await expect(history.locator(".workspace-history__label")).toHaveText("Opened");
  await workspaceUpdated(page);
  await page.screenshot({ path: test.info().outputPath("history-cleared.png") });
  await page.reload();
  await page.goto("/");
  await openStoredWorkspace(page, "Named history");
  await page.getByTestId("workspace-saved").click();
  await expect(history.locator(".workspace-history__name")).toHaveCount(0);
});
