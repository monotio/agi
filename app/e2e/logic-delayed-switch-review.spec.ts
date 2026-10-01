import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";

test("typing while the target project opens preserves the outgoing draft @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const ids = await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const first = prepareLocalProject({ title: "Delayed switch base", kind: "blank" });
    const second = prepareLocalProject({ title: "Delayed switch target", kind: "blank" });
    await first.save();
    await second.save();
    return [first.projectId, second.projectId] as const;
  });
  await page.evaluate((id) => {
    (window as unknown as { __AGI_LOGIC__: { open(id: string): void } }).__AGI_LOGIC__.open(id);
  }, ids[0]);
  const studio = page.getByTestId("logic-studio");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  await expect(studio).toBeVisible({ timeout: 20_000 });
  await expect(status).toContainText("No changes");
  await expect(studio.getByRole("heading", { name: "Delayed switch base" })).toBeVisible();

  // Hold the incoming project's real storage queue. The outgoing editor
  // remains available after its clean recovery settle has completed.
  await page.evaluate(async (id) => {
    const storage = await import("/src/project/gameStorage.ts");
    const gate = new Promise<void>((resolve) => {
      (window as { __AGI_SWITCH_REVIEW_GATE__?: () => void }).__AGI_SWITCH_REVIEW_GATE__ = resolve;
    });
    void storage.serializeWrite(id, () => gate);
    (window as unknown as { __AGI_LOGIC__: { open(id: string): void } }).__AGI_LOGIC__.open(id);
  }, ids[1]);
  await expect(status).toContainText("Opening");
  await editor.locator(".view-lines").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("// newer typing while target opens");
  await expect(editor.locator(".view-lines")).toContainText("newer typing while target opens");
  await page.evaluate(() =>
    (window as { __AGI_SWITCH_REVIEW_GATE__?: () => void }).__AGI_SWITCH_REVIEW_GATE__?.(),
  );

  await expect(page.getByTestId("logic-leave-dialog")).toBeVisible();
  await expect(studio.getByRole("heading", { name: "Delayed switch base" })).toBeVisible();
  await expect(status).toContainText("1 change");
  await expect(editor.locator(".view-lines")).toContainText("newer typing while target opens");
});
