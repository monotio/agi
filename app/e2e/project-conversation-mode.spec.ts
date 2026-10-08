import { expect, test } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";

test("Create waits for a Play conversation owner and still transitions the worker @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.addInitScript(() => {
    const modes: string[] = [];
    Object.assign(window, { conversationProjectModes: modes });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message.type === "projectCreate") modes.push(message.progressMode);
      post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
  });
  const opening = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/src/engine/mainProjectAdmission.ts", async (route) => {
    opening.resolve();
    await release.promise;
    await route.continue();
  });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await page.getByTestId("menu-assistant").click();
  await opening.promise;
  const modes = () =>
    page.evaluate(
      () => (window as unknown as { conversationProjectModes: string[] }).conversationProjectModes,
    );
  expect(await modes()).toEqual(["play"]);
  await page.evaluate(() => {
    location.hash = location.hash.replace("#play/", "#create/");
  });
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  release.resolve();
  await expect.poll(modes).toEqual(["play", "create"]);
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("lazy conversation acquisition reports a stale stored project @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.addInitScript(() => Reflect.deleteProperty(window, "BroadcastChannel"));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  const projectId = await page.evaluate(() =>
    decodeURIComponent(location.hash.slice("#play/".length)),
  );
  const other = await page.context().newPage();
  await other.goto("/");
  const saved = await other.evaluate(async (id) => {
    const { loadAuthoredGame, saveAuthoredGame } = await import("/src/project/gameStorage.ts");
    const project = id as Parameters<typeof loadAuthoredGame>[0];
    const data = (await loadAuthoredGame(project))!;
    data.authoringState = { ...data.authoringState, sources: { logics: [[1, "return;"]] } };
    if (!(await saveAuthoredGame(project, data))) throw new Error("The other tab could not save.");
    return JSON.stringify(await loadAuthoredGame(project));
  }, projectId);
  await page.getByTestId("menu-assistant").click();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        stale: window.__AGI_STATE__?.staleTab,
        reload: window.__AGI_STATE__?.powerUp.offerReload,
        error: window.__AGI_STATE__?.powerUp.error,
      })),
    )
    .toEqual({
      stale: true,
      reload: true,
      error: "Changed in another tab. Editing is paused. Download your unsaved edits, then reload.",
    });
  expect(
    await other.evaluate(async (id) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      return JSON.stringify(await loadAuthoredGame(id as Parameters<typeof loadAuthoredGame>[0]));
    }, projectId),
  ).toBe(saved);
});
