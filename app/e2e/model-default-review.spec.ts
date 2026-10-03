import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openAiSettings } from "./engineProbe.ts";

test("new OpenAI setups default to GPT-6.1 Sol and keep explicit GPT-6 Sol comparisons", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  let calls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com|\/api\/(openai|anthropic)\//, (route) => {
    calls++;
    return route.abort();
  });
  await page.goto("/");
  await openAiSettings(page);
  const dialog = page.getByTestId("ai-settings-dialog");
  await dialog.getByTestId("provider-select").selectOption("openai");
  const model = dialog.getByTestId("model-select");
  const effort = dialog.getByTestId("effort-select");
  await expect(model).toHaveValue("gpt-6.1-sol");
  await expect(effort).toHaveValue("medium");
  await expect(effort.locator('option[value="none"]')).toHaveCount(0);
  await expect(model.locator('option[value="gpt-6-sol"]')).toHaveText("GPT-6 Sol");
  await reviewShot(page, "gpt61-sol-default");
  await model.selectOption("gpt-6-sol");
  await effort.selectOption("none");
  await dialog.getByTestId("ai-settings-save").click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByTestId("catalog-adventure-department").getByTestId("library-thumbnail"),
  ).toBeVisible();
  await page.reload();
  await openAiSettings(page);
  await expect(model).toHaveValue("gpt-6-sol");
  await expect(effort).toHaveValue("none");
  await model.selectOption("gpt-6.1-sol");
  await expect(effort).toHaveValue("medium");
  await expect(effort.locator('option[value="none"]')).toHaveCount(0);
  expect(calls).toBe(0);
});
