import { test, expect, reviewShot } from "./test.ts";
import {
  canvasPicHash,
  enterCreateMode,
  isolateStorage,
  savedGameCard,
  settled,
  textHook,
} from "./engineProbe.ts";

test.use({ viewport: { width: 1440, height: 900 } });

test("Starter stands still for 60 cycles, walks and returns to its standing pose", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Standing hero", kind: "starter" }).save();
  });
  await page.reload();
  await savedGameCard(page, "Standing hero")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("input-line")).toBeEnabled();
  // The worker can enter room 1 before the GPU paints its first picture.
  await expect.poll(() => canvasPicHash(page)).not.toBe(0);
  const idle = await canvasPicHash(page);
  const from = (await textHook(page)).cycle;
  const hashes = new Set<number>();
  await expect
    .poll(
      async () => {
        hashes.add(await canvasPicHash(page));
        return (await textHook(page)).cycle;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(from + 60);
  expect([...hashes]).toEqual([idle]);
  await page.screenshot({ path: test.info().outputPath("starter-standing.png") });

  await page.getByTestId("input-line").focus();
  const start = (await textHook(page)).egoX;
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(start);
  expect(await canvasPicHash(page)).not.toBe(idle);
  await page.keyboard.press("ArrowRight");
  const stoppedAt = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(stoppedAt + 2);
  const standing = (await settled(page)).picHash;
  hashes.clear();
  const stopped = (await textHook(page)).cycle;
  await expect
    .poll(
      async () => {
        hashes.add(await canvasPicHash(page));
        return (await textHook(page)).cycle;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(stopped + 60);
  expect([...hashes]).toEqual([standing]);

  await enterCreateMode(page);
  const createCycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(createCycle);
  await reviewShot(page, "starter-create");
});
