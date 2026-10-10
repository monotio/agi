import { expect, test } from "./test.ts";
import { configureAi, isolateStorage, openWorkspaceAgent } from "./engineProbe.ts";

test("a rejected API key shows a plain sentence in the agent panel", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Key proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await configureAi(page, { provider: "anthropic", key: "test-placeholder" });
  await openWorkspaceAgent(page);
  await page.route("**/api/anthropic/v1/messages*", (route) =>
    route.fulfill({
      status: 401,
      json: {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      },
    }),
  );
  await page.getByTestId("agent-message").fill("Add a lamp");
  await page.getByTestId("agent-send").click();
  const error = page.getByTestId("agent-error");
  await expect(error).toHaveText("Anthropic did not accept your API key. Check it in AI settings.");
  await expect(error).not.toContainText("authentication_error");
});
