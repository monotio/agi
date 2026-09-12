import { cacheGame, waitForCycles } from "./engineProbe.ts";
import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";

test.use({ headless: process.platform !== "darwin" });

test("inspector shows live priority view, picks the drawn object, and lists state diffs", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const game = createContainer();
  // Sky-blue fill + a priority-2 control line across y=100.
  game.putResource(
    "picture",
    1,
    Uint8Array.of(0xf0, 3, 0xf8, 0, 0, 0xf2, 2, 0xf6, 0, 100, 159, 100, 0xff),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) { set(f200); new.room(1); } call.v(v0); return;`, {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "view",
    0,
    buildView({
      loops: [{ cels: [{ width: 8, height: 16, pixels: Array<number>(128).fill(12) }] }],
    }),
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      `
    if (isset(f5)) {
      assignn(v60,1); load.pic(v60); draw.pic(v60); show.pic();
      load.view(0); animate.obj(o0); set.view(o0,0); position(o0,80,140);
      draw(o0); stop.cycling(o0);
      assignn(v42, 7); set(f42);
    } return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: "debug-dock",
    title: "Inspector fixture",
    provider: "stub",
    model: "local-playback",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await waitForCycles(page, 4);

  // The inspector entry lives in the power-up header alongside Ask/Remix.
  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  // The bubble floats above the inspector's overlay marks — dismiss it.
  await page.keyboard.press("Escape");
  const dock = page.getByTestId("debug-dock");
  await expect(dock).toBeVisible();

  // Collapse hides the body; expand restores it.
  await page.getByTestId("dbg-collapse").click();
  await expect(page.getByTestId("dbg-mode-priority")).not.toBeVisible();
  await page.getByTestId("dbg-collapse").click();
  await expect(page.getByTestId("dbg-mode-priority")).toBeVisible();

  // Dragging the header floats the panel; the re-dock button returns it.
  const head = page.getByTestId("dbg-head");
  const headBox = (await head.boundingBox())!;
  await page.mouse.move(headBox.x + 30, headBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(headBox.x - 200, headBox.y + 4, { steps: 4 });
  await page.mouse.up();
  await expect(dock).toHaveClass(/floating/);
  await page.getByTestId("dbg-dock-back").click();
  await expect(dock).not.toHaveClass(/floating/);

  const probePixel = async (x: number, y: number) =>
    page.evaluate(
      (pair: [number, number]) => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
        return Array.from(canvas.getContext("2d")!.getImageData(pair[0], pair[1], 1, 1).data);
      },
      [x, y] as [number, number],
    );

  // Priority mode: the control line row renders as EGA green (2); background
  // band renders as its priority value in EGA.
  await page.getByTestId("dbg-mode-priority").click();
  await expect.poll(async () => probePixel(20, 8 + 100)).toEqual([0, 0xaa, 0, 255]);
  // Control-line pixels are drawn only where the priority line is: above it
  // the default band 4 → EGA red.
  expect(await probePixel(20, 8 + 50)).toEqual([0xaa, 0, 0, 255]);

  // Pick the drawn object: arm inspect, click its centre, latch the card.
  await page.getByTestId("dbg-inspect-toggle").check();
  const overlay = page.getByTestId("dbg-overlay");
  const box = (await overlay.boundingBox())!;
  const bx = box.x;
  const by = box.y;
  // o0 sits at logical (80,140) with an 8x16 cel → displayed x = (80+4)*2.
  await page.mouse.click(
    bx + ((80 + 4) * 2 * box.width) / 320,
    by + ((8 + 132) * box.height) / 200,
  );
  const pick = page.getByTestId("dbg-pick");
  await expect(pick).toBeVisible();
  await expect(pick).toContainText("o0");
  await expect(pick).toContainText("view 0");

  // State tab: v42 was written by logic → shows 7; flag 42 shows set.
  await page.getByTestId("dbg-tab-state").click();
  const vars = page.getByTestId("dbg-vars");
  await expect(vars.locator("button").nth(42)).toHaveText("7");
  const flags = page.getByTestId("dbg-flags");
  await expect(flags.locator("button").nth(42)).toHaveText("1");

  // Flag click writes through the worker: f42 resets.
  await flags.locator("button").nth(42).click();
  await expect(flags.locator("button").nth(42)).toHaveText("·");

  // Timeline tab: the room change (v0 0→1) and our v42 write appear.
  await page.getByTestId("dbg-tab-timeline").click();
  const events = page.getByTestId("dbg-events");
  await expect.poll(async () => events.textContent()).toContain("v0 room 0 → 1");
  await expect.poll(async () => events.textContent()).toContain("v42");

  // Exploded mode: the GPU stage masks the composed frame into priority-band
  // layers under a tilted perspective camera. The cyan sky lives on the band-4
  // layer, so cyan pixels must still reach the canvas.
  await page.getByTestId("dbg-tab-screen").click();
  const gpu = page.getByTestId("gpu-canvas");
  if (await gpu.isVisible()) {
    const cyanPixels = async () => {
      const png = await gpu.screenshot();
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
          const px = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let cyan = 0;
          for (let i = 0; i < px.length; i += 4)
            if (px[i + 1]! > 80 && px[i + 2]! > 80 && px[i]! < px[i + 1]! / 2) cyan++;
          return cyan;
        },
        [...png],
      );
    };
    await page.getByTestId("dbg-mode-explode").click();
    // Software WebGL (CI's SwiftShader) can take seconds for the first
    // exploded frame; the second poll proves it holds, not just flashed.
    await expect.poll(cyanPixels, { timeout: 20_000 }).toBeGreaterThan(500);
    await expect.poll(cyanPixels, { timeout: 20_000 }).toBeGreaterThan(500);
  }

  // Back to game mode.
  await page.getByTestId("dbg-mode-visual").click();
  await expect.poll(async () => probePixel(20, 8 + 50)).toEqual([0, 0xaa, 0xaa, 255]);
  expect(pageErrors).toEqual([]);
});
