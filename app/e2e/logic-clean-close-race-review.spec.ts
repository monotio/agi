import { expect, test } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";

test("typing during clean-close cleanup keeps the edited workspace open @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const projectId = await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const prepared = prepareLocalProject({ title: "Clean close race", kind: "blank" });
    await prepared.save();
    return prepared.projectId as string;
  });
  await page.evaluate((id) => {
    (window as unknown as { __AGI_LOGIC__: { open(id: string): void } }).__AGI_LOGIC__.open(id);
  }, projectId);
  const studio = page.getByTestId("logic-studio");
  const status = page.getByTestId("logic-studio-status");
  const editor = studio.getByTestId("logic-editor");
  await expect(status).toContainText("No changes");
  await editor.locator(".view-lines").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("// first dirty draft");
  await expect(status).toContainText("1 change");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
        return (await listProjectDrafts(id as never)).length;
      }, projectId),
    )
    .toBe(1);

  // Delay only the draft transaction's completion callback: the real delete
  // still commits, while the UI awaits its acknowledgement.
  await page.evaluate(async (id) => {
    const held = new WeakSet<IDBTransaction>();
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (key === `draft/${id}` && this.transaction.mode === "readwrite")
        held.add(this.transaction);
      return get.call(this, key);
    };
    const gate = new Promise<void>((resolve) => {
      (window as { __AGI_CLOSE_REVIEW_GATE__?: () => void }).__AGI_CLOSE_REVIEW_GATE__ = resolve;
    });
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
    const set = descriptor.set!;
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      ...descriptor,
      set(callback: ((this: IDBTransaction, event: Event) => void) | null) {
        const transaction = this as IDBTransaction;
        if (callback === null || !held.has(transaction)) {
          set.call(transaction, callback);
          return;
        }
        set.call(transaction, (event: Event) => {
          void gate.then(() => callback.call(transaction, event));
        });
      },
    });
  }, projectId);
  await expect
    .poll(async () => {
      await page.getByTestId("logic-undo").click();
      return status.textContent();
    })
    .toContain("No changes");
  await page.getByTestId("logic-close").click();
  await expect(studio).toBeVisible();
  await editor.locator(".view-lines").click();
  await page.keyboard.type("// newer typing during cleanup");
  await expect(status).toContainText("1 change");
  await page.evaluate(() =>
    (window as { __AGI_CLOSE_REVIEW_GATE__?: () => void }).__AGI_CLOSE_REVIEW_GATE__?.(),
  );

  // The close reviewed a clean draft. New typing revokes that decision.
  await expect(studio).toBeVisible();
  await expect(status).toContainText("1 change");
  await expect(editor.locator(".view-lines")).toContainText("newer typing during cleanup");
});
