import { cacheGame, textHook, waitForCycles } from "./engineProbe.ts";
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
  // layers under a tilted perspective camera. Three distinct contracts:
  // the layer stack is a different rendering than the flat frame, the band-4
  // sky is reconstructed from the masks (cyan still reaches the canvas), and
  // a pick names the layer that rendered the pixel.
  await page.getByTestId("dbg-tab-screen").click();
  const gpu = page.getByTestId("gpu-canvas");
  if (await gpu.isVisible()) {
    const canvasPixels = async (bytes: number[]) =>
      page.evaluate(async (b) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(b)], { type: "image/png" }),
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
        const samples: number[] = [];
        for (let i = 0; i < px.length; i += 4096) samples.push(px[i]!, px[i + 1]!, px[i + 2]!);
        return { cyan, samples };
      }, bytes);
    const shot = async () => canvasPixels([...(await gpu.screenshot())]);
    const flat = await shot();
    await page.getByTestId("dbg-mode-explode").click();
    // Software WebGL (CI's SwiftShader) can take seconds for the first
    // exploded frame; poll until cyan arrives, then compare the footprint.
    let exploded = await shot();
    await expect
      .poll(async () => (exploded = await shot()).cyan, { timeout: 20_000 })
      .toBeGreaterThan(500);
    // Separation is applied: the exploded stack is not the flat bitmap again.
    expect(exploded.samples).not.toEqual(flat.samples);

    // Mask-aware picking: a tap raycasts the layer stack, so the latched
    // pick names the band that rendered the pixel — not the nearest quad.
    // The canvas centre is sky (picture band 4): the nearer text quad is
    // transparent there and every sprite quad masks out without an owner,
    // so the pick must fall through to the band-4 wall.
    const overlay3d = (await page.getByTestId("dbg-overlay").boundingBox())!;
    await page.mouse.click(overlay3d.x + overlay3d.width / 2, overlay3d.y + overlay3d.height / 2);
    const pick3d = page.getByTestId("dbg-pick");
    await expect(pick3d).toBeVisible();
    await expect(pick3d).toContainText("layer");
    await expect(pick3d).toContainText("picture band 4");
    await expect(pick3d).toContainText("background");
  }

  // Back to game mode.
  await page.getByTestId("dbg-mode-visual").click();
  await expect.poll(async () => probePixel(20, 8 + 50)).toEqual([0, 0xaa, 0xaa, 255]);
  expect(pageErrors).toEqual([]);
});

test("show.obj renders as its own layer in flat and exploded views, then restores", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const game = createContainer();
  // Cyan fill; a solid red 8x16 cel becomes the show.obj preview.
  game.putResource(
    "picture",
    1,
    Uint8Array.of(0xf0, 3, 0xf8, 0, 0, 0xf2, 4, 0xf6, 0, 100, 159, 100, 0xff),
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
      load.view(0);
    }
    if (isset(f43)) { reset(f43); show.obj(0); }
    return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: "debug-showobj",
    title: "ShowObj fixture",
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

  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  await page.keyboard.press("Escape");
  const dock = page.getByTestId("debug-dock");
  await expect(dock).toBeVisible();

  const probePixel = async (x: number, y: number) =>
    page.evaluate(
      (pair: [number, number]) => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
        return Array.from(canvas.getContext("2d")!.getImageData(pair[0], pair[1], 1, 1).data);
      },
      [x, y] as [number, number],
    );

  // The modal opens when logic sees f43; the inspector's flag write triggers it.
  await page.getByTestId("dbg-tab-state").click();
  await page.getByTestId("dbg-flags").locator("button").nth(43).click();
  await expect.poll(async () => (await textHook(page)).modal).toBe("showObj");

  // Flat view: the cel is bottom-centre of the picture band (logical 76..83,
  // 152..167 → displayed 152..167 x 160..175), light red over the cyan sky.
  await expect.poll(async () => probePixel(160, 168)).toEqual([0xff, 0x55, 0x55, 255]);

  // A flat pick on the cel reports the pixel honestly: no sprite owns it.
  await page.getByTestId("dbg-tab-screen").click();
  await page.getByTestId("dbg-inspect-toggle").check();
  const overlay = page.getByTestId("dbg-overlay");
  const obox = (await overlay.boundingBox())!;
  await page.mouse.click(obox.x + (160 * obox.width) / 320, obox.y + (168 * obox.height) / 200);
  const pick = page.getByTestId("dbg-pick");
  await expect(pick).toBeVisible();
  await expect(pick).toContainText("background");

  // Escape dismisses (Enter would re-click the focused flag button): the cel
  // pixels restore to the sky fill underneath.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await expect.poll(async () => probePixel(160, 168)).toEqual([0, 0xaa, 0xaa, 255]);

  // Reopen over the live scene: wait for the state poll to observe the reset
  // flag so the click writes a SET, then explode. The preview is its own
  // layer floating in front of the sprite bands, and the pick names it.
  await page.getByTestId("dbg-tab-state").click();
  await expect(page.getByTestId("dbg-flags").locator("button").nth(43)).toHaveText("·");
  await page.getByTestId("dbg-flags").locator("button").nth(43).click();
  await expect.poll(async () => (await textHook(page)).modal).toBe("showObj");
  const gpu = page.getByTestId("gpu-canvas");
  if (await gpu.isVisible()) {
    await page.getByTestId("dbg-tab-screen").click();
    await page.getByTestId("dbg-mode-explode").click();
    // The exploded preview layer is front-most of the band stack and scales
    // around the band centre, so probe a small grid around the flat position
    // until the raycast latches it.
    const box = (await overlay.boundingBox())!;
    let latched = "";
    for (const dy of [0, 10, 20, 34, 48, -8]) {
      for (const dx of [0, -14, 14]) {
        await page.mouse.click(
          box.x + (160 + dx) * (box.width / 320),
          box.y + (168 + dy) * (box.height / 200),
        );
        const text = await page.getByTestId("dbg-pick").textContent();
        if (text?.includes("modal preview")) {
          latched = text;
          break;
        }
      }
      if (latched) break;
    }
    expect(latched).toContain("modal preview");
    await expect(pick).toContainText("cycle");
    // The preview carries no object identity — honest even while visible.
    await expect(pick).toContainText("background");
  }

  // Close again from exploded: the layer disappears with the modal.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await page.getByTestId("dbg-mode-visual").click();
  await expect.poll(async () => probePixel(160, 168)).toEqual([0, 0xaa, 0xaa, 255]);
  expect(pageErrors).toEqual([]);
});
