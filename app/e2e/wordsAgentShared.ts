import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { isolateStorage, configureAi } from "./engineProbe.ts";

export async function checkWordsAgentHandoff(
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  if (width === 390) await page.getByTestId("workspace-parts").click();
  await page.getByTestId("part-words").click();
  const words = page.getByTestId("workspace-words-editor");
  await expect(words).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`words-${width}-before.png`) });
  await words.getByRole("button", { name: "Suggest sentences", exact: true }).click();
  const panel = page.getByTestId("workspace-agent-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("agent-message")).toHaveValue(
    "Predict what players will try in Meadow",
  );
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath(`words-${width}-after.png`) });
}
