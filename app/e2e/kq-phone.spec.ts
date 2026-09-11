import { expect, test, type Page } from "@playwright/test";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { isolateStorage, textHook, waitForCycles, waitForFrames } from "./engineProbe.ts";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

async function coloredFraction(page: Page): Promise<number> {
  const png = await page.getByTestId("gpu-canvas").screenshot();
  return page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        const channels = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
        if (Math.max(...channels) - Math.min(...channels) > 60) colored++;
      }
      return colored / (pixels.length / 4);
    },
    [...png],
  );
}

// Local Sierra resources only. These runs establish opening-room input and
// persistence behavior; they do not claim that the complete games were played.
for (const game of [
  { hash: KNOWN_GAME_HASH.KQ1, alias: "kq1", intro: 83, room: 1, profile: "2.917", maxScore: 158 },
  { hash: KNOWN_GAME_HASH.KQ2, alias: "kq2", intro: 97, room: 1, profile: "2.411", maxScore: 185 },
  { hash: KNOWN_GAME_HASH.KQ3, alias: "kq3", intro: 45, room: 7, profile: "2.936", maxScore: 210 },
]) {
  const missing = fixtureSkip(game.hash, ["AGIDATA.OVL"]);
  test(`${game.alias} opens, walks, saves and restores using phone controls`, async ({ page }) => {
    test.skip(Boolean(missing), missing || "");
    await isolateStorage(page);
    await page.goto("/");
    await page
      .locator(
        `[data-hash="${game.hash}"], [data-alias="${game.alias}"], [data-testid="boot-${game.alias}"]`,
      )
      .first()
      .tap();
    await expect.poll(async () => (await textHook(page)).profile).toBe(game.profile);
    await expect.poll(async () => (await textHook(page)).room).toBe(game.intro);
    const pad = page.getByTestId("touch-controls");
    await expect(pad).toBeVisible();
    await expect
      .poll(
        async () => {
          const state = await textHook(page);
          if (state.room !== game.room)
            await pad.getByRole("button", { name: "Enter", exact: true }).tap();
          return (await textHook(page)).room;
        },
        { timeout: 20_000 },
      )
      .toBe(game.room);
    await expect.poll(async () => (await textHook(page)).rows[0] ?? "").toContain("Score:");
    await expect
      .poll(async () => (await textHook(page)).rows[0] ?? "")
      .toContain(`of ${game.maxScore}`);
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    await waitForCycles(page, 2);
    const start = await textHook(page);

    await pad.getByText("Keys", { exact: true }).tap();
    await pad.getByRole("button", { name: "F5", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBe("save");
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect(page.getByTestId("prompt-hint")).toBeVisible();
    await page.getByTestId("input-line").fill("Phone opening room");
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "))
      .toContain("Save in slot 1?");
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();

    const east = pad.getByRole("button", { name: "Walk east", exact: true });
    await east.tap();
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(start.egoX);
    await east.tap();
    await waitForCycles(page, 2);
    const stopped = await textHook(page);
    await waitForCycles(page, 3);
    expect((await textHook(page)).egoX).toBe(stopped.egoX);
    expect(stopped.room).toBe(game.room);

    await pad.getByRole("button", { name: "F7", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBe("restore");
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "))
      .toContain("Phone opening room");
    await pad.getByRole("button", { name: "Enter", exact: true }).tap();
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
    await expect.poll(async () => (await textHook(page)).egoX).toBe(start.egoX);
    expect((await textHook(page)).egoY).toBe(start.egoY);
    expect((await textHook(page)).room).toBe(game.room);
    await pad.getByText("Keys", { exact: true }).tap();
    await waitForFrames(page, 2);
    // The GPU image must contain the colored room, not the gray save selector.
    await expect.poll(() => coloredFraction(page)).toBeGreaterThan(0.1);
    await page.screenshot({ path: test.info().outputPath(`${game.alias}-phone.png`) });
  });
}
