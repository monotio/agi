import { expect, reviewShot, test } from "./test.ts";
import {
  blockProviders,
  focusEditor,
  openLogicOne,
  prepareIsolatedPage,
  seedLocalProject,
} from "./logicDebugShared.ts";

test("Code to Sound and back preserves unkept source and caret @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Sibling retained work");
  await page.evaluate((id) => {
    (window as unknown as { __AGI_LOGIC__: { open(id: string): void } }).__AGI_LOGIC__.open(id);
  }, projectId);
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await openLogicOne(page);
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("\n// unkept source across sibling navigation");
  await page.keyboard.press("ArrowLeft");
  const caret = await page.evaluate(() =>
    (window as unknown as { __AGI_LOGIC__: { cursor(): unknown } }).__AGI_LOGIC__.cursor(),
  );
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");

  // This invokes the same shell route a sibling navigation control uses.
  // It tests mounted state retention, independently of button placement.
  await page.evaluate((id) => {
    (window as unknown as { __AGI_SOUND__: { open(id: string): void } }).__AGI_SOUND__.open(id);
  }, projectId);
  await expect(page.getByTestId("sound-studio")).toBeVisible();
  await page.getByTestId("sound-open-code").click();
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getModels()
          .find((model) => model.uri.toString().endsWith("/logic%3A1"))
          ?.getValue();
      }),
    )
    .toContain("unkept source across sibling navigation");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  expect(
    await page.evaluate(() =>
      (window as unknown as { __AGI_LOGIC__: { cursor(): unknown } }).__AGI_LOGIC__.cursor(),
    ),
  ).toEqual(caret);
  await expect(page.getByTestId("logic-recovery-dialog")).toHaveCount(0);
  await reviewShot(page, "studio-sibling-retained-source");
  expect(providers.count()).toBe(0);
});
