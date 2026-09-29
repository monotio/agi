import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";
import type { Page } from "@playwright/test";

async function seed(page: Page, title: string): Promise<string> {
  return page.evaluate(async (name) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const project = prepareLocalProject({ title: name, kind: "blank" });
    await project.save();
    return project.projectId;
  }, title);
}

async function edit(page: Page, title: string): Promise<void> {
  await openLibraryActions(page, savedGameCard(page, title));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText("return;");
}

async function appendComment(page: Page): Promise<void> {
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// authored without a key");
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
}

test("offline Logic Studio keeps an exact source-only edit and reopens it", async ({ page }) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  const projectId = await seed(page, "Source review");
  await page.reload();
  await edit(page, "Source review");
  await appendComment(page);
  await page.getByTestId("logic-review-build").click();
  await expect(page.getByTestId("logic-review-dialog")).toBeVisible();
  await expect(page.getByTestId("logic-review-dialog")).toContainText("LOGIC 1");
  await page.getByTestId("logic-review-doc-logic:1").click();
  const diff = page.getByTestId("logic-review-diff");
  await expect(diff.locator(".modified .view-lines")).toContainText("authored without a key");
  await expect(diff.locator(".original .view-lines")).not.toContainText("authored without a key");
  await expect(diff.locator(".modified .line-insert").first()).toBeVisible();
  await reviewShot(page, "logic-studio-source-review");
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  const source = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(id as never);
    const content = data?.workspace?.documents.find((doc) => doc.key === "logic:1")?.content;
    return content?.type === "text" ? content.text : null;
  }, projectId);
  expect(source).toMatch(/\n\/\/ authored without a key$/);
  await page.getByTestId("logic-close").click();
  await expect(page.getByTestId("logic-studio")).toBeHidden();
  await edit(page, "Source review");
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "authored without a key",
  );
  await reviewShot(page, "logic-studio-source-reopened");
  expect(providerCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("a project switch asks about dirty Logic Studio work before changing identity", async ({
  page,
}) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.goto("/");
  await seed(page, "First workspace");
  const second = await seed(page, "Second workspace");
  await page.reload();
  await edit(page, "First workspace");
  await appendComment(page);
  // Exercise the same public shell entry used by library Edit. The library
  // underneath is intentionally inert while the first workspace is open.
  await page.evaluate((id) => {
    const hook = (window as unknown as { __AGI_LOGIC__: { open(projectId: string): void } })
      .__AGI_LOGIC__;
    hook.open(id);
  }, second);
  await expect(page.getByTestId("logic-leave-dialog")).toBeVisible();
  await expect(
    page.getByTestId("logic-studio").getByRole("heading", { name: "First workspace", exact: true }),
  ).toBeVisible();
  await reviewShot(page, "logic-studio-switch-dirty-guard");
});

test("an immediate Keep disposes the review without an unhandled diff failure", async ({
  page,
}) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seed(page, "Fast review");
  await page.reload();
  await edit(page, "Fast review");
  await appendComment(page);
  await page.getByTestId("logic-review-build").click();
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("No changes");
  await page.getByTestId("logic-close").click();
  await expect(page.getByTestId("logic-studio")).toBeHidden();
  await edit(page, "Fast review");
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "authored without a key",
  );
  expect(errors).toEqual([]);
});

test("failed draft discard keeps the workspace open and permits a truthful retry", async ({
  page,
}) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.goto("/");
  const projectId = await seed(page, "Discard retry");
  await page.reload();
  await edit(page, "Discard retry");
  await appendComment(page);
  const draftCount = () =>
    page.evaluate(async (id) => {
      const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
      return (await listProjectDrafts(id as never)).length;
    }, projectId);
  await expect.poll(draftCount).toBe(1);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key) {
      if (typeof key === "string" && key.startsWith("draft/")) {
        IDBObjectStore.prototype.delete = original;
        throw new Error("temporary draft deletion failure");
      }
      return original.call(this, key);
    };
  });
  await page.getByTestId("logic-close").click();
  await page.getByTestId("logic-leave-discard").click();
  expect(await draftCount()).toBe(1);
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await expect(page.getByTestId("logic-persist-error")).toContainText(
    "temporary draft deletion failure",
  );
  expect(await draftCount()).toBe(1);
  // The error may leave the close dialog open or return to the editor. Both
  // are valid as long as the user can explicitly retry the same discard.
  if (!(await page.getByTestId("logic-leave-dialog").isVisible())) {
    await page.getByTestId("logic-close").click();
  }
  await page.getByTestId("logic-leave-discard").click();
  await expect(page.getByTestId("logic-studio")).toBeHidden();
  expect(await draftCount()).toBe(0);
});

test("a selected Keep leaves unrelated broken source recoverable", async ({ page }) => {
  await isolateStorage(page);
  // These editor scenarios use local projects rather than the development
  // fixture shelf and its independent thumbnail fetches.
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const projectId = await seed(page, "Selected changes");
  await page.reload();
  await edit(page, "Selected changes");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:0").click();
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("if broken");
  await page.keyboard.press("Escape");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await page.getByTestId("logic-editor").locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// selected source kept");
  await expect(page.getByTestId("logic-studio-status")).toContainText("2 changes");
  await page.getByTestId("logic-review-build").click();
  const review = page.getByTestId("logic-review-dialog");
  await expect(review).toBeVisible();
  await expect(page.getByTestId("logic-review-error")).toBeVisible();
  await review.getByTestId("logic-review-include-logic:0").getByRole("checkbox").uncheck();
  await expect(page.getByTestId("logic-keep-confirm")).toBeEnabled();
  await review.getByTestId("logic-review-doc-logic:1").click();
  await expect(
    review.getByTestId("logic-review-diff").locator(".modified .view-lines"),
  ).toContainText("selected source kept");
  await expect(
    review.getByTestId("logic-review-diff").locator(".modified .line-insert").first(),
  ).toBeVisible();
  await reviewShot(page, "logic-studio-selected-keep");
  await page.getByTestId("logic-keep-confirm").click();
  await expect(page.getByTestId("logic-studio-status")).toContainText("1 change");
  const kept = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(id as never);
    return data?.workspace?.documents.filter(
      (doc) => doc.key === "logic:0" || doc.key === "logic:1",
    );
  }, projectId);
  const zero = kept?.find((doc) => doc.key === "logic:0")?.content;
  const one = kept?.find((doc) => doc.key === "logic:1")?.content;
  expect(zero?.type === "text" ? zero.text : "").not.toContain("if broken");
  expect(one?.type === "text" ? one.text : "").toContain("selected source kept");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const { listProjectDrafts } = await import("/src/project/projectDrafts.ts");
        return (await listProjectDrafts(id as never)).some(
          (draft) =>
            draft.status === "current" &&
            draft.recovery.documents.some((doc) => doc.key === "logic:0"),
        );
      }, projectId),
    )
    .toBe(true);
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Selected changes"));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("logic-recovery-dialog")).toBeVisible();
  await page
    .getByTestId("logic-recovery-dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:0").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText("if broken");
  await page.getByTestId("logic-explorer").getByTestId("logic-doc-logic:1").click();
  await expect(page.getByTestId("logic-editor").locator(".view-lines")).toContainText(
    "selected source kept",
  );
  expect(errors).toEqual([]);
});
