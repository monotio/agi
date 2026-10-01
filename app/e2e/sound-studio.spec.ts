import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { openContainer } from "../../src/container/container.ts";
import { importSoundDocument } from "../../src/sound/document.ts";
import { expect, test, reviewShot } from "./test.ts";
import {
  isolateStorage,
  observe,
  openLibraryActions,
  savedGameCard,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Sound Studio's real navigation path: the saved-game card's menu opens the
 * stored project in the cue workspace — no engine, no provider, no key — and
 * Keep admits through the same draft/build/review authority Logic Studio
 * uses. The running-game spec drives the actual worker pause path: opening
 * the studio freezes the interpreter, preview adds its own lease on top, and
 * closing hands the running game back unmuted and unpaused-by-us.
 */

/** Seed a saved project through the same storage path "Create game" uses. */
async function seedLocalProject(
  page: Page,
  title: string,
  kind: "blank" | "starter" = "blank",
): Promise<string> {
  const projectId = await page.evaluate(
    async ({ title, kind }) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const prepared = prepareLocalProject({ title, kind });
      await prepared.save();
      return prepared.projectId as string;
    },
    { title, kind },
  );
  await page.waitForLoadState("networkidle");
  return projectId;
}

/** The exact native payload of one kept SOUND resource, from storage. */
async function storedSoundBytes(page: Page, projectId: string, num: number) {
  const files = await page.evaluate(async (id) => {
    const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
    const data = await loadAuthoredGame(id as never);
    if (!data) return null;
    return Object.fromEntries(Object.entries(data.files).map(([k, v]) => [k, [...v]]));
  }, projectId);
  if (files === null) return null;
  const container = openContainer(
    new Map(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v as number[])])),
  );
  const payload = container.getResource("sound", num);
  return payload === null ? null : [...payload];
}

/** True while the interpreter sits frozen under at least one hold. */
async function cyclesFrozen(page: Page): Promise<boolean> {
  const first = (await textHook(page)).cycle;
  await observe(page, 20);
  return (await textHook(page)).cycle === first;
}

test("library Sound Studio creates, edits, keeps and exports an exact native cue @webkit-desktop", async ({
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
  const projectId = await seedLocalProject(page, "Cue work", "blank");
  await page.reload();

  const card = savedGameCard(page, "Cue work");
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game-sound")
    .click();
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("sound-studio-status")).toContainText("Saved");

  // Create a cue from the Danger preset at the lowest free number.
  await page.getByTestId("sound-new").click();
  await page.getByTestId("sound-preset-danger").click();
  const cueName = page.getByTestId("sound-cue-name");
  await expect(cueName).toContainText("SOUND");
  const num = Number((await cueName.textContent())!.replace(/\D/g, ""));
  await expect(studio.getByTestId(`sound-item-${num}`)).toBeVisible();
  const lane0 = studio.getByTestId("sound-lane-0");
  await expect(lane0.locator(".sound-event").first()).toBeVisible();
  const count0 = await lane0.locator(".sound-event").count();
  await reviewShot(page, "sound-studio-preset-cue");

  // Edit the first event: duration, pitch and volume through the inspector.
  await lane0.locator(".sound-event").first().click();
  const ticks = page.getByTestId("sound-event-ticks");
  await ticks.fill("24");
  await ticks.press("Tab");
  const note = page.getByTestId("sound-event-note");
  await note.fill("A4");
  await note.press("Tab");
  const att = page.getByTestId("sound-event-attenuation");
  await expect(note).toHaveValue("A4");
  await expect(page.getByText("Volume (0–15)", { exact: true })).toHaveAttribute(
    "title",
    /AGI attenuation/,
  );
  await att.fill("11");
  await att.press("Tab");
  await expect(page.getByTestId("sound-edit-error")).toBeHidden();
  // The event's own label proves the commits landed in the document —
  // a silently dropped commit would leave the preset's values there.
  const edited = lane0.locator(".sound-event").first();
  await expect(edited).toHaveAttribute("aria-label", /24t/);
  await expect(edited).toHaveAttribute("aria-label", /volume 11/);

  // Keyboard: the focused event's lane takes a rest at its cursor; lane 3's
  // track takes a noise hit. Delete removes the selected event.
  await lane0.locator(".sound-event").first().click();
  await page.keyboard.press("r");
  await expect(lane0.locator(".sound-event")).toHaveCount(count0 + 1);
  const lane3 = studio.getByTestId("sound-lane-3");
  const noise0 = await lane3.locator(".sound-event").count();
  const track3 = studio.getByTestId("sound-lane-track-3");
  const box3 = (await track3.boundingBox())!;
  await track3.click({ position: { x: Math.max(8, box3.width - 12), y: 12 } });
  await page.keyboard.press("n");
  await expect(lane3.locator(".sound-event")).toHaveCount(noise0 + 1);
  await lane3.locator(".sound-event").last().click();
  const control = page.getByTestId("sound-event-control");
  await expect(control).toBeVisible();
  await control.selectOption("6");
  await expect(page.getByTestId("sound-studio-status")).toContainText(/\d+ changes?/);

  // Delete the selected noise event; undo restores it, redo removes it again.
  await page.keyboard.press("Delete");
  await expect(lane3.locator(".sound-event")).toHaveCount(noise0);
  await page.getByTestId("sound-undo").click();
  await expect(lane3.locator(".sound-event")).toHaveCount(noise0 + 1);
  await page.getByTestId("sound-redo").click();
  await expect(lane3.locator(".sound-event")).toHaveCount(noise0);
  await page.getByTestId("sound-undo").click();
  await expect(lane3.locator(".sound-event")).toHaveCount(noise0 + 1);

  // Keep through the review dialog, then cold-reload and reopen.
  await page.getByTestId("sound-keep").click();
  await expect(page.getByTestId("sound-review")).toBeVisible();
  await page.getByTestId("sound-review-keep").click();
  await expect(page.getByTestId("sound-studio-status")).toContainText("Saved");
  await page.getByTestId("sound-close").click();
  await expect(studio).toBeHidden();

  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Cue work"));
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game-sound")
    .click();
  await expect(studio).toBeVisible();
  await studio.getByTestId(`sound-item-${num}`).click();
  await expect(cueName).toContainText(`SOUND ${num}`);
  await expect(lane0.locator(".sound-event")).toHaveCount(count0 + 1);

  // Download asserts exact bytes against the stored container resource.
  const expected = await storedSoundBytes(page, projectId, num);
  expect(expected).not.toBeNull();
  // The kept native payload decodes to the edited document: the edited tone
  // is 24 ticks at attenuation 4 (the inserted rest sits before it), and
  // lane 3's last event carries control 6.
  const kept = importSoundDocument(new Uint8Array(expected!), { profileId: "2.936" });
  const tracks = kept.tracks()!;
  const editedTone = tracks[0]!.find(
    (event) => event.durationTicks === 24 && event.data.kind === "tone",
  )!;
  expect(editedTone).toBeDefined();
  if (editedTone.data.kind === "tone") expect(editedTone.data.attenuation).toBe(4);
  const lastNoise = tracks[3]!.at(-1)!;
  expect(lastNoise.data.kind).toBe("noise");
  if (lastNoise.data.kind === "noise") expect(lastNoise.data.control & 7).toBe(6);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("sound-export").click(),
  ]);
  const file = await readFile((await download.path())!);
  expect([...file]).toEqual(expected);
  expect(providerCalls).toBe(0);
});

test("Sound Studio over a running game freezes the worker and its preview releases only its own hold @webkit-desktop", async ({
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
  const projectId = await seedLocalProject(page, "Playable cue", "starter");
  await page.reload();

  // Boot the real game, then open Sound Studio over it: the mount's own hold
  // freezes the interpreter and parks the gameplay audio context.
  const card = savedGameCard(page, "Playable cue");
  await card.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await waitForCycles(page, 3);
  await page.evaluate((id) => {
    (window as { __AGI_SOUND__?: { open(id: string): void } }).__AGI_SOUND__!.open(id);
  }, projectId);
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible();
  expect(await cyclesFrozen(page)).toBe(true);
  expect(
    await page.evaluate(() => window.__AGI_AUDIO__?.isPaused ?? null),
    "the gameplay audio context is held while the studio covers the game",
  ).toBe(true);

  // Create a cue so the preview has a target, then run it: the audition takes
  // its own lease on top of the mount hold and the worker stays frozen.
  await page.getByTestId("sound-new").click();
  await page.getByTestId("sound-preset-success").click();
  await expect(page.getByTestId("sound-cue-name")).toContainText("SOUND");
  await page.getByTestId("sound-play").click();
  await expect(page.getByTestId("sound-pause")).toBeVisible();
  expect(await cyclesFrozen(page)).toBe(true);

  // Stopping the preview releases only the audition's lease: the studio's own
  // mount hold survives it, so the game stays frozen — the foreign owner.
  await page.getByTestId("sound-stop").click();
  await expect(page.getByTestId("sound-play")).toBeVisible();
  expect(await cyclesFrozen(page)).toBe(true);

  // Discarding the edit closes over the leave guard; the run resumes cleanly.
  await page.getByTestId("sound-close").click();
  await expect(page.getByTestId("sound-leave-ask")).toBeVisible();
  await page.getByTestId("sound-leave-discard").click();
  await expect(studio).toBeHidden();
  await expect
    .poll(async () => page.evaluate(() => window.__AGI_AUDIO__?.isPaused ?? null))
    .toBe(false);
  await waitForCycles(page, 2);
  expect(providerCalls).toBe(0);
});

test("library Sound Studio reviews and keeps a cue removal across a cold reopen @webkit-desktop", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  const projectId = await seedLocalProject(page, "Cue removal", "blank");
  await page.reload();

  const card = savedGameCard(page, "Cue removal");
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game-sound")
    .click();
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible();

  // Create and keep a cue so the removal deletes a kept native resource.
  await page.getByTestId("sound-new").click();
  await page.getByTestId("sound-preset-danger").click();
  const cueName = page.getByTestId("sound-cue-name");
  const num = Number((await cueName.textContent())!.replace(/\D/g, ""));
  const item = studio.getByTestId(`sound-item-${num}`);
  await expect(item).toBeVisible();
  await page.getByTestId("sound-keep").click();
  await page.getByTestId("sound-review-keep").click();
  await expect(page.getByTestId("sound-studio-status")).toContainText("Saved");

  // Remove stages the draft change only — the cue leaves the list and Undo
  // restores it before anything commits.
  await page.getByTestId("sound-remove-cue").click();
  await expect(item).toHaveCount(0);
  await expect(page.getByTestId("sound-studio-status")).toContainText(/\d+ changes?/);
  expect(await storedSoundBytes(page, projectId, num)).not.toBeNull();
  await page.getByTestId("sound-undo").click();
  await expect(item).toBeVisible();

  // Remove again, then cancel the review: the staged removal keeps the cue
  // absent from the draft without a durable write.
  await item.click();
  await page.getByTestId("sound-remove-cue").click();
  await expect(item).toHaveCount(0);
  await page.getByTestId("sound-keep").click();
  const removals = page.getByTestId("sound-review-removals");
  await expect(removals).toBeVisible();
  await expect(removals).toContainText(`sound:${num}`);
  await page.getByTestId("sound-review-cancel").click();
  await expect(page.getByTestId("sound-review")).toBeHidden();
  await expect(page.getByTestId("sound-studio-status")).toContainText(/\d+ changes?/);
  expect(await storedSoundBytes(page, projectId, num)).not.toBeNull();

  // Commit the reviewed removal.
  await page.getByTestId("sound-keep").click();
  await expect(removals).toContainText(`sound:${num}`);
  await page.getByTestId("sound-review-keep").click();
  await expect(page.getByTestId("sound-studio-status")).toContainText("Saved");
  await page.getByTestId("sound-close").click();
  await expect(studio).toBeHidden();

  // Cold reopen: no native resource, no source document, no music entry.
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Cue removal"));
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game-sound")
    .click();
  await expect(studio).toBeVisible();
  await expect(item).toHaveCount(0);
  expect(await storedSoundBytes(page, projectId, num)).toBeNull();
  const kept = await page.evaluate(
    async ({ id, num }) => {
      const { loadAuthoredGame } = await import("/src/project/gameStorage.ts");
      const data = await loadAuthoredGame(id as never);
      if (!data || data.workspace === undefined) return null;
      const documents = data.workspace.documents;
      const music = documents.find(
        (document) => document.key === "music" && document.content.type === "text",
      );
      return {
        soundSource: documents.find((document) => document.key === `sound:${num}`) === undefined,
        musicEntry:
          music === undefined ||
          (music.content.type === "text" && JSON.parse(music.content.text)[num] === undefined),
      };
    },
    { id: projectId, num },
  );
  expect(kept).toEqual({ soundSource: true, musicEntry: true });
  expect(providerCalls).toBe(0);
  expect(errors).toEqual([]);
});

test("a project switch during open lands on the newer project with no stale state @webkit-desktop", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.goto("/");
  const firstId = await seedLocalProject(page, "Earlier cue project", "blank");
  const secondId = await seedLocalProject(page, "Newer cue project", "blank");
  await page.reload();

  // The second open supersedes the first before its load resolves.
  await page.evaluate(
    async ({ firstId, secondId }) => {
      const sound = (window as { __AGI_SOUND__?: { open(id: string): void } }).__AGI_SOUND__!;
      sound.open(firstId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      sound.open(secondId);
    },
    { firstId, secondId },
  );
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible();
  await expect(studio.locator(".sound-studio__title p")).toHaveText("Newer cue project");
  await expect(page.getByTestId("sound-open-error")).toBeHidden();

  // The newer workspace edits and keeps normally — nothing from the stale
  // open leaked into its draft or selection state.
  await page.getByTestId("sound-new").click();
  await page.getByTestId("sound-preset-blank").click();
  await expect(page.getByTestId("sound-cue-name")).toContainText("SOUND");
  await page.getByTestId("sound-keep").click();
  await page.getByTestId("sound-review-keep").click();
  await expect(page.getByTestId("sound-studio-status")).toContainText("Saved");
  await page.getByTestId("sound-close").click();
  await expect(studio).toBeHidden();
  expect(errors).toEqual([]);
});
