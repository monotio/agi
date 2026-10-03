import { expect, test } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { readFile } from "node:fs/promises";

test("draw, audition, track and import MIDI beside the game @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Step music");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.getByTestId("part-sound:1").click();
  const panel = page.getByTestId("workspace-sound").filter({ visible: true });
  const grid = panel.getByTestId("sound-grid");
  await expect(grid).toBeVisible();
  await expect(panel.getByTestId("sound-play")).toHaveCSS("border-radius", "50%");
  await expect(panel.getByTestId("sound-play")).toHaveAttribute("title", /Space/);
  await expect(panel.locator(".sound-voice-swatch")).toHaveCount(4);
  await expect(panel.locator(".sound-voice-swatch").first()).toHaveCSS("width", "10px");
  await expect(panel.locator(".sound-voice-swatch").first()).toBeVisible();
  await expect(panel).not.toContainText("Ready");
  await expect(panel.locator(".sound-heading")).not.toContainText("Music and sound effects");
  await panel.getByLabel("Snap", { exact: true }).selectOption("8");
  // C5 row 12, step 8 at 120 BPM = tick 120. Drag to step 11 = 60 ticks.
  const box = await grid.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 64 + 8 * 26 + 4, box!.y + 24 + 12 * 20 + 10);
  await page.mouse.down();
  await page.mouse.move(box!.x + 64 + 11 * 26 + 12, box!.y + 24 + 12 * 20 + 10, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  // Move off the note so the pixel probe measures its fill, without the selection outline.
  await grid.press("ArrowDown");
  const readNotePixels = () =>
    grid.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      const ratio = canvas.width / parseFloat(canvas.style.width);
      const pixel = (x: number, y: number) => [
        ...context.getImageData(x * ratio, y * ratio, 1, 1).data,
      ];
      // C5 is row 12; this note starts at step 8 and ends at step 12.
      return {
        corner: pixel(64 + 8 * 26 + 1, 24 + 12 * 20 + 2),
        center: pixel(64 + 8 * 26 + 12, 24 + 12 * 20 + 10),
      };
    });
  const loudPixels = await readNotePixels();
  expect(loudPixels.corner.slice(0, 3).reduce((sum, channel) => sum + channel, 0)).toBeLessThan(
    loudPixels.center.slice(0, 3).reduce((sum, channel) => sum + channel, 0),
  );
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(panel.getByLabel("Voice 1, tick 120, note", { exact: true })).toHaveValue("C5");
  await expect(panel.getByLabel("Voice 1, tick 120, length in ticks", { exact: true })).toHaveValue(
    "60",
  );
  await panel.getByLabel("Voice 1, tick 120, volume in hex", { exact: true }).fill("A");
  await panel.getByLabel("Voice 1, tick 120, volume in hex", { exact: true }).press("Enter");
  await panel.getByRole("button", { name: "Grid", exact: true }).click();
  await grid.press("ArrowDown");
  const quietPixels = await readNotePixels();
  expect(quietPixels.center.slice(0, 3).reduce((sum, channel) => sum + channel, 0)).toBeLessThan(
    loudPixels.center.slice(0, 3).reduce((sum, channel) => sum + channel, 0),
  );
  const cycle = (await textHook(page)).cycle;
  await panel.getByTestId("sound-play").click();
  await expect(panel.getByTestId("sound-play")).toHaveAttribute("aria-label", "Stop");
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await expect.poll(() => page.evaluate(() => window.__AGI_AUDIO__?.isPlaying)).toBe(false);
  await grid.focus();
  await grid.press("Space");
  await expect(panel.getByTestId("sound-play")).toHaveAttribute("aria-label", "Play");
  // Keyboard draws a second voice and lengthens it in one native edit.
  await panel.getByRole("button", { name: "Voice 2", exact: true }).click();
  await grid.focus();
  await grid.press("ArrowRight");
  await grid.press("ArrowDown");
  await grid.press("Enter");
  await grid.press("Shift+ArrowRight");
  await panel.getByRole("button", { name: "Drums", exact: true }).click();
  await panel.getByTestId("sound-drums").click({ position: { x: 64 + 4 * 26 + 4, y: 10 } });
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: test.info().outputPath(`grid-${size.width}.png`),
      animations: "disabled",
    });
    await panel.getByRole("button", { name: "Tracker", exact: true }).click();
    await page.screenshot({
      path: test.info().outputPath(`tracker-${size.width}.png`),
      animations: "disabled",
    });
    await panel.getByRole("button", { name: "Grid", exact: true }).click();
  }
  // Synthetic SMF: A4 at native tick 11 for one tick, between eighth-note cells.
  const midi = Buffer.from([
    77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224, 77, 84, 114, 107, 0, 0, 0, 13, 129, 48, 144,
    69, 127, 16, 128, 69, 0, 0, 255, 47, 0,
  ]);
  await panel
    .getByLabel("Music file", { exact: true })
    .setInputFiles({ name: "generated.mid", mimeType: "audio/midi", buffer: midi });
  const summary = panel.getByTestId("sound-import-summary");
  await expect(summary).toContainText("Timing rounded to 60 Hz");
  await expect(panel.getByRole("button", { name: "Replace SOUND 1", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(panel.getByLabel("Voice 1, tick 120, note", { exact: true })).toHaveValue("C5");
  await summary.getByRole("button", { name: "Replace SOUND 1", exact: true }).click();
  await expect(panel.getByLabel("Voice 1, tick 11, note", { exact: true })).toHaveValue("A4");
  await expect(panel.getByLabel("Voice 1, tick 11, length in ticks", { exact: true })).toHaveValue(
    "1",
  );
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export MIDI", exact: true }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe("sound-1.mid");
  const downloadBytes = await readFile((await exported.path())!);
  expect([...downloadBytes.subarray(0, 14)]).toEqual([
    77, 84, 104, 100, 0, 0, 0, 6, 0, 1, 0, 5, 0, 60,
  ]);
  await panel.getByLabel("Voice 1, tick 11, note", { exact: true }).focus();
  await panel.getByRole("button", { name: "Grid", exact: true }).click();
  await grid.focus();
  await grid.press("Delete");
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(panel.getByLabel("Voice 1, tick 11, note", { exact: true })).toHaveValue("Rest");
  // Drop on the game while another editor is open creates a SOUND only after review.
  await page.getByTestId("part-room:1:logic").click();
  const transfer = await page.evaluateHandle(
    (data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(data)], "dropped.mid", { type: "audio/midi" }));
      return transfer;
    },
    [...midi],
  );
  await page.locator(".play-area").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByTestId("sound-import-summary").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("part-sound:2")).toHaveCount(0);
  await page
    .getByTestId("sound-import-summary")
    .filter({ visible: true })
    .getByRole("button", { name: "Add SOUND", exact: true })
    .click();
  await expect(page.getByTestId("part-sound:2")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
});
