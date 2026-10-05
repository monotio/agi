import { expect, test } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { waitForSignal } from "./browserSignals.ts";

test("Play loads its surface while the game worker is loading", async ({ page }) => {
  await isolateStorage(page);
  const workerRequested = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  await page.route("**/engine.worker.ts*", async (route) => {
    workerRequested.resolve();
    await releaseWorker.promise;
    await route.continue();
  });
  let surfaceRequested = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/src/play/PlayArea.vue") surfaceRequested = true;
  });
  await page.goto("/");
  expect(surfaceRequested).toBe(false);
  await page.getByTestId("catalog-play-adventure-department").click();
  await workerRequested.promise;
  try {
    await waitForSignal(
      () => surfaceRequested,
      (check) => {
        page.on("request", check);
        return () => page.off("request", check);
      },
    );
    expect((await textHook(page)).profile).toBeNull();
    await expect(page.getByTestId("input-line")).toBeHidden();
  } finally {
    releaseWorker.resolve();
  }
  await expect(page.getByTestId("input-line")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});
