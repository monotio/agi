import { expect, test, reviewShot } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, textHook, openWorldRoom } from "./engineProbe.ts";
import { STUDIO_TERMS, type StudioTerm } from "../src/studio/studioTerms.ts";

/**
 * Every ⓘ in the Studios explains itself: in each lens of Room Studio and in
 * Sprite Studio, every visible `[data-term]` opens its registry sentence
 * (studioTerms.ts), Esc closes it before the Studio's own Esc chain runs and
 * hands focus back to it, and Learn more opens Help at its topic. The chrome
 * itself speaks the new words: with two items selected, no visible Room
 * Studio text says priority, control line, command, playhead, plane or
 * visual (explainers and closed Details keep AGI's words for those who
 * look).
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
}

async function openRoomOne(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/**
 * Open and close every visible explainer in `root`: each says its registry
 * sentence, and Esc closes it with focus back on its button. `still` must
 * hold after each Esc: the Studio's own Esc did not run. The terms seen.
 */
async function everyExplainer(
  page: Page,
  root: Locator,
  still: () => Promise<void>,
): Promise<string[]> {
  const triggers = root.locator("[data-term]:visible");
  const count = await triggers.count();
  expect(count, "the surface has explainers").toBeGreaterThan(0);
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    const term = (await trigger.getAttribute("data-term")) as StudioTerm;
    expect(Object.keys(STUDIO_TERMS), `${term} is a registry term`).toContain(term);
    await expect(trigger).toHaveAccessibleName(`What is ${STUDIO_TERMS[term].name}?`);
    await trigger.click();
    const pop = page.getByTestId("explain-pop");
    await expect(pop).toHaveAttribute("data-term", term);
    await expect(pop.getByRole("heading")).toHaveText(STUDIO_TERMS[term].name);
    await expect(pop.getByTestId("explain-says")).toHaveText(STUDIO_TERMS[term].says);
    await expect(pop.getByTestId("explain-more")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await still();
    seen.push(term);
  }
  return seen;
}

test("Room Studio: every explainer in every lens says its sentence and gives Esc back", async ({
  page,
}) => {
  await playTutorial(page);
  const studio = await openRoomOne(page);
  await studio.getByRole("treeitem", { name: /^Text band/ }).click();
  await studio.getByRole("treeitem", { name: /^Corners & floor line/ }).click({
    modifiers: ["Shift"],
  });
  // A drawing tool in hand: the Studio's own Esc would put it down.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("r");
  const rect = studio.locator('button[data-tool="rect"]');
  await expect(rect).toHaveAttribute("aria-pressed", "true");
  const still = async () => {
    await expect(rect).toHaveAttribute("aria-pressed", "true");
    await expect(studio.getByTestId("inspector-title")).toContainText("2 items");
  };
  const seen = new Set<string>();
  for (const key of ["1", "2", "3"]) {
    await studio.getByRole("group", { name: /^Canvas/ }).focus();
    await page.keyboard.press(key);
    for (const term of await everyExplainer(page, studio, still)) seen.add(term);
  }
  for (const term of ["lens-lock-depth", "lens-lock-art", "lens-lock-walk", "order", "step"])
    expect([...seen], `the ${term} explainer shows`).toContain(term);

  // A mouse resting on an ⓘ opens it with focus left on the canvas; Esc then
  // closes the explainer, and only the explainer.
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  await canvas.focus();
  await studio.getByTestId("scrubber-step").getByTestId("explain-step").hover();
  const pop = page.getByTestId("explain-pop");
  await expect(pop).toHaveAttribute("data-term", "step");
  await expect(canvas).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await still();
  await expect(canvas).toBeFocused();
  // Moving away closes a resting explainer by itself.
  await page.mouse.move(10, 10);
  await studio.getByTestId("scrubber-step").getByTestId("explain-step").hover();
  await expect(pop).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(pop).toHaveCount(0);
});

test("Room Studio: the lock chip's Learn more opens Help at Locks @webkit-desktop", async ({
  page,
}) => {
  await playTutorial(page);
  const studio = await openRoomOne(page);
  const trigger = studio
    .locator(".top-bar__lens")
    .getByTestId("studio-lock-chip")
    .getByTestId("explain-lens-lock-depth");
  await trigger.click();
  const pop = page.getByTestId("explain-pop");
  await expect(pop.getByTestId("studio-unlock")).toHaveText("Unlock for now");
  await reviewShot(page, "room-lock-explainer");
  await pop.getByTestId("explain-more").click();
  const guide = page.getByTestId("help-guide");
  await expect(guide).toBeVisible();
  await expect(guide.getByTestId("help-section-creating")).toHaveAttribute("aria-current", "true");
  const heading = guide.locator("#help-topic-studio-locks");
  await expect(heading).toHaveText("Locks");
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(studio).toBeVisible();
});

test("Room Studio's chrome says depth, walk lines and steps", async ({ page }) => {
  await playTutorial(page);
  const studio = await openRoomOne(page);
  await studio.getByRole("treeitem", { name: /^Text band/ }).click();
  await studio.getByRole("treeitem", { name: /^Corners & floor line/ }).click({
    modifiers: ["Shift"],
  });
  const pane = studio.locator(".studio-pane").last();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await expect(studio.getByTestId("studio-status")).toContainText("depth");
  for (const key of ["1", "2", "3"]) {
    await studio.getByRole("group", { name: /^Canvas/ }).focus();
    await page.keyboard.press(key);
    const text = await studio.innerText();
    expect(
      text.match(/\b(priorit(y|ies)|control lines?|commands?|playhead|planes?|visual)\b/gi),
      `lens ${key}: retired words in the chrome`,
    ).toBeNull();
  }
});

test("Sprite Studio: every explainer says its sentence and gives Esc back", async ({ page }) => {
  await playTutorial(page);
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-sprite-0").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("e");
  const eraser = studio.locator('button[data-tool="eraser"]');
  await expect(eraser).toHaveAttribute("aria-pressed", "true");
  const seen = await everyExplainer(page, studio, async () => {
    await expect(studio).toBeVisible();
    await expect(eraser).toHaveAttribute("aria-pressed", "true");
  });
  for (const term of ["transparent", "loops", "shared-view"])
    expect(seen, `the ${term} explainer shows`).toContain(term);
});
