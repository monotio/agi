import { expect, test } from "./test.ts";
import { prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { encodePngRgb } from "../../src/picture/png.ts";

test("a deferred dock open cannot adopt into a reopened studio @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Dock lifetime");
  await page.evaluate(async (id) => {
    const fixtureUrl: string = "/e2e/fixtures/creativeDockReview.ts";
    const fixture = await import(fixtureUrl);
    await fixture.mount(id);
    await fixture.holdWrites();
  }, projectId);
  await page.getByTestId("review-open-dock").click();
  await page.evaluate(async () => {
    const fixtureUrl: string = "/e2e/fixtures/creativeDockReview.ts";
    const fixture = await import(fixtureUrl);
    await fixture.replaceStudio();
    await fixture.settleOpen();
  });
  await expect(page.getByTestId("creative-workspace")).toHaveCount(0);
  await page.evaluate(async () => {
    const fixtureUrl: string = "/e2e/fixtures/creativeDockReview.ts";
    (await import(fixtureUrl)).unmount();
  });
});

test("a newer paste keeps its file and origin while an older dock open settles @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => route.abort());
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Intake ownership");
  await page.evaluate(async (id) => {
    const url: string = "/e2e/fixtures/creativeDockReview.ts";
    const fixture = await import(url);
    await fixture.mount(id);
    await fixture.holdWrites();
  }, projectId);
  const first = encodePngRgb(4, 4, new Uint8Array(4 * 4 * 3).fill(40));
  const second = encodePngRgb(4, 4, new Uint8Array(4 * 4 * 3).fill(100));
  await page.evaluate(
    ({ first, second }) => {
      const host = document.querySelector(".studio-host");
      if (host === null) throw new Error("actual studio dock is not mounted");
      const files = (bytes: number[], name: string) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(bytes)], name, { type: "image/png" }));
        return transfer;
      };
      host.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: files(first, "older.png"),
          bubbles: true,
          cancelable: true,
        }),
      );
      host.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: files(second, "newer.png"),
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { first: [...first], second: [...second] },
  );
  await page.evaluate(async () => {
    const url: string = "/e2e/fixtures/creativeDockReview.ts";
    await (await import(url)).settleOpen();
  });
  const panel = page.getByTestId("creative-workspace");
  await expect(panel).toBeVisible();
  const latest = panel.locator(".source-preview").filter({ hasText: "newer.png" });
  await expect(latest, "an older open cannot discard the newer accepted file").toBeVisible();
  await latest.locator("summary").click();
  await expect(latest.locator("dd").first(), "the source carries its own paste origin").toHaveText(
    "paste",
  );
  await page.evaluate(async () => {
    const url: string = "/e2e/fixtures/creativeDockReview.ts";
    (await import(url)).unmount();
  });
});

test("a refused dock intake reports once without retrying storage in a loop @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  const projectId = await seedLocalProject(page, "Refused dock intake");
  const reads = await page.evaluate(async (id) => {
    const url: string = "/e2e/fixtures/creativeDockReview.ts";
    const fixture = await import(url);
    await fixture.mount(id);
    await fixture.removeSavedProject();
    return fixture.countRefusedOpenReads();
  }, projectId);
  expect(reads, "a refused intake must wait for another explicit gesture").toBe(1);
  await expect(page.locator(".studio-host__error")).toContainText("no saved data");
  // Unmount before the final assertion to clean up this mounted fixture.
  await page.evaluate(async () => {
    const url: string = "/e2e/fixtures/creativeDockReview.ts";
    (await import(url)).unmount();
  });
  expect(reads, "a refused intake must wait for another explicit gesture").toBe(1);
});
