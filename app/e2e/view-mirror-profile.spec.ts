import { readFile } from "node:fs/promises";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildView, parseView } from "../../src/view/view.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";
import {
  closeWorkspaceEditor,
  downloadFromSettings,
  isolateStorage,
  openWorkspaceView,
  openInspector,
  textHook,
  workspaceSaved,
  workspaceUpdated,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

// 2.001 has no native mirror routine: an imported mirror bit is ignored,
// while Add mirror compiles the requested facing as independent reversed cels.
test("Studio keeps early-profile imported art and plays its newly added mirror after export", async ({
  page,
}) => {
  const profile = PROFILES["2.001"];
  const game = createContainer();
  const original = buildView({
    loops: [
      { cels: [{ width: 3, height: 1, transparentColor: 0, pixels: [1, 2, 0] }] },
      { mirrorLoop: 0 },
    ],
  });
  game.putResource("view", 0, original);
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) {
      set(f200); accept.input(); set.key(109, 0, c1);
      load.view(0); animate.obj(o0); set.view(o0, 0);
      fix.loop(o0); stop.cycling(o0); set.loop(o0, 1);
      position(o0, 20, 80); draw(o0);
    }
    if (controller(c1)) { set.loop(o0, 2); }
    return;
  `,
      { dictionary: new Map(), profile },
    ).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = new Map(game.files);
  files.set(
    "GAME.JSON",
    new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi",
        version: 1,
        title: "Mirror workshop",
        profile: profile.id,
      }),
    ),
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "Mirror workshop.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data })))),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(profile.id);
  let studio = await openWorkspaceView(page, 0);
  const documentPixels = async (loop: number) => {
    const payload = Uint8Array.from(await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]));
    return [...parseView(payload, profile).loops[loop]!.cels[0]!.pixels];
  };
  const thumbPixels = (loop: number) =>
    studio
      .locator(`[data-loop="${loop}"][data-cel="0"] canvas`)
      .evaluate((canvas) => [
        ...(canvas as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 3, 1).data,
      ]);
  const bytes = () => page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]);
  await expect.poll(() => thumbPixels(1)).toEqual([0, 0, 170, 255, 0, 170, 0, 255, 0, 0, 0, 0]);
  await expect.poll(() => documentPixels(1)).toEqual([1, 2, 0]);
  expect(await bytes()).toEqual([...original]);
  await studio.getByTestId("sprite-loop-0-menu").click();
  await page.getByRole("menuitem", { name: "Add mirror of this loop", exact: true }).click();
  await expect.poll(() => documentPixels(2)).toEqual([0, 2, 1]);
  await expect.poll(() => thumbPixels(2)).toEqual([0, 0, 0, 0, 0, 170, 0, 255, 0, 0, 170, 255]);
  await studio.locator('[data-loop="2"][data-cel="0"]').click();
  await workspaceSaved(page);
  const edited = await bytes();
  const native = parseView(Uint8Array.from(edited), profile);
  expect([...native.loops[0]!.cels[0]!.pixels]).toEqual([1, 2, 0]);
  expect([...native.loops[1]!.cels[0]!.pixels]).toEqual([1, 2, 0]);
  expect([...native.loops[2]!.cels[0]!.pixels]).toEqual([0, 2, 1]);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: test.info().outputPath(`view-mirror-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await workspaceUpdated(page);
  await closeWorkspaceEditor(page);
  studio = await openWorkspaceView(page, 0);
  await expect(studio).toBeVisible();
  expect(await bytes()).toEqual(edited);
  await expect.poll(() => documentPixels(2)).toEqual([0, 2, 1]);
  await closeWorkspaceEditor(page);
  const downloading = page.waitForEvent("download");
  await downloadFromSettings(page);
  const archive = await readFile((await (await downloading).path())!);
  const exported = await readGameZip(archive);
  expect(exported.profile).toBe(profile.id);
  const payload = openContainer(new Map(Object.entries(exported.files)), { profile }).getResource(
    "view",
    0,
  )!;
  expect([...payload]).toEqual(edited);
  // Reimport through the app's normal archive reader, then reopen Studio.
  await page.goto("/");
  await page
    .getByTestId("game-zip-input")
    .setInputFiles({ name: "Mirror export.zip", mimeType: "application/zip", buffer: archive });
  await page
    .getByRole("article")
    .filter({ hasText: "Imported copy" })
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(profile.id);
  await openWorkspaceView(page, 0);
  await expect.poll(() => documentPixels(2)).toEqual([0, 2, 1]);
  await closeWorkspaceEditor(page);
  await openInspector(page);
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("m");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const frame = window.__AGI_FRAME__?.();
        return frame ? [...frame.visual.slice(80 * 160 + 20, 80 * 160 + 23)] : null;
      }),
    )
    .toEqual([15, 2, 1]);
});
