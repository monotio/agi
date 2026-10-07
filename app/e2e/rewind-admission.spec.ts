import { savePlayProgress } from "./engineProbe.ts";
import { pasteWorkspaceLogic } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import {
  isolateStorage,
  openGameOptions,
  textHook,
  waitForCycles,
  workspaceUpdated,
} from "./engineProbe.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

async function projectState(page: Page) {
  return page.evaluate(() => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: { getSession(): ProjectSession | null };
      }
    ).__AGI_PROJECT__.getSession();
    return {
      token: session?.runToken ?? "",
      commits: session?.capture().history.commits.length ?? -1,
      source: (session?.model.capture().read("logic:1")?.content as string | undefined) ?? "",
    };
  });
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const diagnostic = await page.evaluate(async () => ({
    text: window.__AGI_TEXT__,
    phase: window.__AGI_STATE__?.phase,
    status: window.__AGI_STATE__?.status,
    busy: window.__AGI_STATE__?.powerUp.busy,
    history: window.__AGI_STATE__?.historyView,
    worker: await (
      window as unknown as { __AGI_PROJECT__: { query: (type: "state") => Promise<unknown> } }
    ).__AGI_PROJECT__.query("state"),
  }));
  await info.attach("rewind-state", {
    body: JSON.stringify(diagnostic),
    contentType: "application/json",
  });
});

for (const action of ["Resume from here", "Undo rewind", "Undo start over"] as const) {
  test(`${action} in Create admits the next LOGIC edit and saves its History commit @webkit-desktop`, async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill("Rewind proof");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await waitForCycles(page, 4);
    await expect.poll(async () => (await projectState(page)).token).not.toBe("");
    const original = await projectState(page);
    if (action === "Resume from here") {
      await page.getByTestId("part-room:1:logic").click();
      await page.getByTestId("workspace-focus").click();
      await page.locator(".monaco-editor").click();
      await page.keyboard.press("ControlOrMeta+a");
      await pasteWorkspaceLogic(page, original.source + "\n// Before rewind");
      expect((await projectState(page)).commits).toBe(original.commits);
      await workspaceUpdated(page);
      await expect.poll(async () => (await projectState(page)).commits).toBe(original.commits + 1);
      await expect(page.getByTestId("workspace-saved")).toBeVisible();
      await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
      await page.getByTestId("workspace-show-game").click();
    }
    // The timeline is in Play; switching modes retains the Create session.
    await page.getByRole("radio", { name: "Play", exact: true }).click();

    if (action === "Undo start over") {
      await openGameOptions(page, "settings-menu");
      await page.getByTestId("btn-start-over").click();
      await expect(page.getByTestId("btn-undo-start-over")).toBeVisible();
      await page.getByTestId("btn-undo-start-over").click();
      await expect(page.getByTestId("start-over-note")).toBeHidden();
    } else {
      await page.getByTestId("btn-transport-pause").click();
      const timeline = page.getByTestId("history-timeline");
      await expect(timeline).toHaveAttribute("aria-valuenow", "100");
      const box = (await timeline.boundingBox())!;
      await timeline.click({ position: { x: box.width * 0.2, y: box.height / 2 } });
      await expect(page.getByTestId("btn-history-resume")).toBeEnabled();
      await page.getByTestId("btn-history-resume").click();
      await expect(page.getByTestId("btn-undo-rewind")).toBeVisible();
      if (action === "Undo rewind") {
        await expect
          .poll(() => page.evaluate(() => window.__AGI_STATE__?.powerUp.busy))
          .toBe(false);
        await expect.poll(async () => (await textHook(page)).paused).toBe(false);
        await page.evaluate(() => {
          const gate = window as unknown as {
            releaseBranchRead: () => void;
            branchReadHeld: boolean;
          };
          const get = IDBObjectStore.prototype.get;
          const set = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!.set!;
          let claimed = false;
          IDBObjectStore.prototype.get = function (key) {
            if (!claimed && typeof key === "string" && key.startsWith("history/")) {
              claimed = true;
              const transaction = this.transaction;
              Object.defineProperty(transaction, "oncomplete", {
                set(callback: (event: Event) => void) {
                  set.call(transaction, (event: Event) => {
                    gate.branchReadHeld = true;
                    gate.releaseBranchRead = () => {
                      IDBObjectStore.prototype.get = get;
                      callback.call(transaction, event);
                    };
                  });
                },
              });
            }
            return get.call(this, key);
          };
        });
        await page.getByTestId("btn-undo-rewind").click();
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { branchReadHeld: boolean }).branchReadHeld),
          )
          .toBe(true);
        await expect.poll(() => page.evaluate(() => window.__AGI_STATE__?.powerUp.busy)).toBe(true);
        await expect(page.getByRole("radio", { name: "Create", exact: true })).toBeDisabled();
        await page.evaluate(() =>
          (window as unknown as { releaseBranchRead: () => void }).releaseBranchRead(),
        );
      }
    }
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__AGI_STATE__;
          return (
            state?.powerUp.busy === false &&
            state.historyView.parked === false &&
            !state.historyView.loading &&
            !state.historyView.active
          );
        }),
      )
      .toBe(true);
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
    await page.getByRole("radio", { name: "Create", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Create", exact: true })).toBeChecked();
    await expect.poll(async () => (await projectState(page)).source).toBe(original.source);
    await page.getByTestId("part-room:1:logic").click();
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    const before = await projectState(page);
    const message = "A blue flower grows.";
    const source = before.source.replace(
      "You stand in a sunny clearing. A path leads past a grey cottage and a big leafy tree.",
      message,
    );
    expect(source).not.toBe(before.source);
    await page.getByTestId("workspace-focus").click();
    await page.locator(".monaco-editor").click();
    await page.keyboard.press("ControlOrMeta+a");
    await pasteWorkspaceLogic(page, source);
    expect((await projectState(page)).commits).toBe(before.commits);
    await workspaceUpdated(page);
    await expect.poll(async () => (await projectState(page)).commits).toBe(before.commits + 1);
    await expect(page.getByTestId("workspace-saved")).toBeVisible();
    await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
    await page.getByTestId("workspace-show-game").click();
    await page.keyboard.press("Control+`");
    await page.keyboard.type("look");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain(message);
    await page.keyboard.press("Enter");
    await savePlayProgress(page);
    await page.reload();
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await expect.poll(async () => (await projectState(page)).source).toBe(source);
    expect((await projectState(page)).commits).toBe(before.commits + 1);
  });
}
