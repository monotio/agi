import type { Locator, Page } from "@playwright/test";
import { expect, test, reviewShot } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

/**
 * Sound Studio's mounted control review at a laptop viewport: the transport's
 * Stop carries a stop glyph rather than a close cross, the position spells
 * ticks and seconds out, the device choice sits behind a visible Preview
 * label, every lane's M/S has a real accessible name matching its tooltip and
 * a 24px target aligned across the four heads, and an unselected editable cue
 * tells the creator what to do next. The status chip counts document changes
 * like the sibling studios. No engine, no provider, no key.
 */

test.use({ viewport: { width: 1280, height: 720 } });

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(page: Page, title: string): Promise<string> {
  const projectId = await page.evaluate(async (name) => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    const prepared = prepareLocalProject({ title: name, kind: "blank" });
    await prepared.save();
    return prepared.projectId as string;
  }, title);
  await page.waitForLoadState("networkidle");
  return projectId;
}

/** Every box edge inside the viewport, and both dimensions at 24px or more. */
async function expectControlBounds(
  control: Locator,
  name: string,
  viewport: { width: number; height: number },
): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${name} is visible`).not.toBeNull();
  expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(24);
  expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(24);
  expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${name} top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height, `${name} bottom edge`).toBeLessThanOrEqual(viewport.height);
}

test("Sound Studio controls are named, aligned and 24px or larger @webkit-desktop", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  await seedLocalProject(page, "Cue controls");
  await page.reload();

  const card = savedGameCard(page, "Cue controls");
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game-sound")
    .click();
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible();

  // A native cue from the Danger preset: lane 0 holds tone-rest-tone, lane 2
  // a held bass tone, extent 34 ticks. The cue names itself by SND number.
  await page.getByTestId("sound-new").click();
  await page.getByTestId("sound-preset-danger").click();
  const cueName = page.getByTestId("sound-cue-name");
  await expect(cueName).toBeVisible();
  expect((await cueName.textContent())!.trim()).toMatch(/^SND \d+$/);

  // The unselected editable cue explains itself in the inspector and under
  // the timeline; the status chip counts dirty documents like the studios.
  const cueHint = page.getByTestId("sound-cue-hint");
  await expect(cueHint).toContainText("Select a note or rest to edit it.");
  await expect(cueHint).toContainText("Click the timeline to use these keys");
  await expect(page.getByTestId("sound-hint")).toContainText(
    "Click the timeline to use these keys",
  );
  const status = page.getByTestId("sound-studio-status");
  await expect(status).toContainText(/\d+ changes/);

  // Transport: a labelled Preview region whose Stop is a square, with the
  // position spelled as current/total ticks plus seconds.
  await expect(page.getByTestId("sound-preview-label")).toHaveText("Preview");
  const play = page.getByTestId("sound-play");
  const stop = page.getByTestId("sound-stop");
  await expect(play).toHaveAttribute("aria-label", "Play preview");
  await expect(stop).toHaveAttribute("aria-label", "Stop preview");
  await expect(stop.locator("svg rect")).toHaveCount(1);
  const position = page.getByTestId("sound-position");
  expect((await position.textContent())!.replace(/\s+/g, " ").trim()).toBe("0 / 34 ticks · 0.57 s");

  // The device pair keeps its truthful tooltips.
  await expect(page.getByTestId("sound-device-speaker")).toHaveAttribute(
    "title",
    "Preview as the one-voice PC speaker",
  );
  await expect(page.getByTestId("sound-device-tandy")).toHaveAttribute(
    "title",
    "Preview as the three-voice chip",
  );

  // Lane heads: the M/S accessible names match their tooltips, and every
  // gate sits at the same offsets on all four heads.
  const laneNames = ["Voice 1", "Voice 2", "Voice 3", "Noise"];
  const muteX: number[] = [];
  const soloX: number[] = [];
  for (let lane = 0; lane < 4; lane++) {
    const mute = studio.getByTestId(`sound-mute-${lane}`);
    const solo = studio.getByTestId(`sound-solo-${lane}`);
    await expect(mute).toHaveAttribute("aria-label", `Mute ${laneNames[lane]} in preview`);
    await expect(mute).toHaveAttribute("title", `Mute ${laneNames[lane]} in preview`);
    await expect(solo).toHaveAttribute("aria-label", `Solo ${laneNames[lane]} in preview`);
    await expect(solo).toHaveAttribute("title", `Solo ${laneNames[lane]} in preview`);
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await expect(solo).toHaveAttribute("aria-pressed", "false");
    muteX.push((await mute.boundingBox())!.x);
    soloX.push((await solo.boundingBox())!.x);
  }
  expect(new Set(muteX).size, "mute buttons share one x across the four heads").toBe(1);
  expect(new Set(soloX).size, "solo buttons share one x across the four heads").toBe(1);
  expect(soloX[0]!, "solo sits right of mute").toBeGreaterThan(muteX[0]!);

  // Target size and viewport bounds for every control this review touched.
  const controls: [string, Locator][] = [
    ["undo", page.getByTestId("sound-undo")],
    ["redo", page.getByTestId("sound-redo")],
    ["keep", page.getByTestId("sound-keep")],
    ["close", page.getByTestId("sound-close")],
    ["new", page.getByTestId("sound-new")],
    ["import", page.getByTestId("sound-import")],
    ["play", play],
    ["stop", stop],
    ["speaker", page.getByTestId("sound-device-speaker")],
    ["tandy", page.getByTestId("sound-device-tandy")],
    ["duplicate", page.getByTestId("sound-duplicate")],
    ["replace", page.getByTestId("sound-replace-file")],
    ["export", page.getByTestId("sound-export")],
    ["remove cue", page.getByTestId("sound-remove-cue")],
    ["zoom out", page.getByTestId("sound-zoom-out")],
    ["zoom in", page.getByTestId("sound-zoom-in")],
  ];
  for (let lane = 0; lane < 4; lane++) {
    controls.push(
      [`mute ${lane}`, studio.getByTestId(`sound-mute-${lane}`)],
      [`solo ${lane}`, studio.getByTestId(`sound-solo-${lane}`)],
    );
  }
  const viewport = page.viewportSize()!;
  for (const [name, control] of controls) await expectControlBounds(control, name, viewport);

  // Press toggles: mute lane 0, solo the noise lane, then release both.
  const mute0 = studio.getByTestId("sound-mute-0");
  const solo3 = studio.getByTestId("sound-solo-3");
  await mute0.click();
  await expect(mute0).toHaveAttribute("aria-pressed", "true");
  await solo3.click();
  await expect(solo3).toHaveAttribute("aria-pressed", "true");
  await solo3.click();
  await expect(solo3).toHaveAttribute("aria-pressed", "false");
  await mute0.click();
  await expect(mute0).toHaveAttribute("aria-pressed", "false");

  // Keyboard: the focused track takes N for a note and R for a rest; Escape
  // hands the unselected hint back.
  const lane0 = studio.getByTestId("sound-lane-0");
  const count0 = await lane0.locator(".sound-event").count();
  await studio.getByTestId("sound-lane-track-0").click({ position: { x: 400, y: 12 } });
  await page.keyboard.press("n");
  await expect(lane0.locator(".sound-event")).toHaveCount(count0 + 1);
  await page.keyboard.press("r");
  await expect(lane0.locator(".sound-event")).toHaveCount(count0 + 2);
  await lane0.locator(".sound-event").first().click();
  await expect(page.getByTestId("sound-event-ticks")).toBeVisible();
  await expect(cueHint).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(cueHint).toBeVisible();

  // Play, then Stop: the transport returns to Play and the position resets.
  // The inserted note and rest grew the cue's extent to 64 ticks.
  await play.click();
  await expect(page.getByTestId("sound-pause")).toBeVisible();
  await stop.click();
  await expect(play).toBeVisible();
  await expect
    .poll(async () => (await position.textContent())!.replace(/\s+/g, " ").trim())
    .toBe("0 / 64 ticks · 1.07 s");

  await reviewShot(page, "sound-studio-controls-review");
  expect(providerCalls).toBe(0);
});
