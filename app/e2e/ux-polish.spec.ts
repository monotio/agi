import { decodePng } from "../../scripts/png.ts";
import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { isolateStorage, openWorkspaceAgent, playFromCreate, textHook } from "./engineProbe.ts";

async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Layout proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  if (page.viewportSize()!.width > 600) await expect(page.getByTestId("parts-list")).toBeVisible();
}

test.describe("compact layout", () => {
  test.use({ gpuStage: true });
  for (const size of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`Parts makes room for the Agent and restores the player layout ${size.width}${size.width === 390 ? " @phone" : size.width === 1063 ? " @webkit-desktop" : ""}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await starter(page);
      await page.evaluate(() => localStorage.setItem("monotio_agi.crtAmount", "1"));
      await page.reload();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect(page.getByTestId("gpu-canvas")).toBeVisible();
      const saved = await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"));
      await openWorkspaceAgent(page);
      await page.screenshot({
        path: test.info().outputPath(`create-agent-${size.width}.png`),
        animations: "disabled",
      });
      await page
        .getByTestId("workspace-agent-panel")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await playFromCreate(page);
      await expect(page.locator(".play-bar")).toHaveCSS("border-bottom-width", "1px");
      await expect(page.locator(".play-strip")).toHaveCSS("border-top-width", "1px");
      if (size.width > 600) {
        await expect(page.getByLabel("Game command", { exact: true })).toBeEnabled();
        await page.getByLabel("Game command", { exact: true }).focus();
        await expect(
          page.locator(".play-strip").getByText("Keys go to the game", { exact: true }),
        ).toBeVisible();
      }
      await expect
        .poll(async () => greenPicturePixels(await page.getByTestId("gpu-canvas").screenshot()))
        .toBeGreaterThan(1000);
      await page.screenshot({
        path: test.info().outputPath(`play-${size.width}-agent-closed.png`),
        animations: "disabled",
      });
      if (size.width === 1063) {
        const gpu = page.getByTestId("gpu-canvas");
        await page.getByRole("radio", { name: "Play", exact: true }).focus();
        await expect(
          page.locator(".play-strip").getByText("Click the game to play", { exact: true }),
        ).toBeVisible();
        const unfocused = cyanEdgePixels(await gpu.screenshot());
        await page.getByLabel("Game command", { exact: true }).focus();
        await expect
          .poll(async () => cyanEdgePixels(await gpu.screenshot()))
          .toBeGreaterThan(unfocused);
      }

      await openWorkspaceAgent(page);
      if (size.width === 1063) {
        await expect(page.getByTestId("parts-list")).toBeHidden();
        expect(
          await page.locator(".play-area").evaluate((el) => el.getBoundingClientRect().width),
        ).toBeGreaterThan(600);
      }
      if (size.width === 1440) await expect(page.getByTestId("parts-list")).toBeVisible();
      await page
        .getByTestId("workspace-agent-panel")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      if (size.width > 600) await expect(page.getByTestId("parts-list")).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(
        saved,
      );
      if (size.width === 1440) {
        await page.keyboard.press("ControlOrMeta+b");
        await expect(page.getByTestId("parts-list")).toBeHidden();
        await page.evaluate(() => {
          const project = location.hash.replace(/^#create\//, "");
          localStorage.setItem(`monotio_agi.workspaceRename.${project}`, "1");
        });
        await page.reload();
        await openWorkspaceAgent(page);
        await page.getByRole("button", { name: "Add a room", exact: true }).click();
        await expect(page.getByTestId("room-rename-input")).toBeVisible();
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(page.getByTestId("room-rename-input")).toBeVisible();
        await page.getByTestId("room-rename-input").press("Escape");
        await page.keyboard.press("ControlOrMeta+b");
      }
      if (size.width === 1063) {
        await openWorkspaceAgent(page);
        await page.setViewportSize({ width: 1200, height: 815 });
        await expect(page.getByTestId("parts-list")).toBeVisible();
        await page.setViewportSize({ width: 1199, height: 815 });
        await expect(page.getByTestId("parts-list")).toBeHidden();
        await page.setViewportSize(size);
        await page.getByTestId("workspace-parts").click();
        await expect(page.getByTestId("parts-list")).toBeVisible();
        await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
        await page.keyboard.press("ControlOrMeta+b");
        await expect(page.getByTestId("parts-list")).toBeHidden();
        await page.keyboard.press("ControlOrMeta+b");
        await expect(page.getByTestId("parts-list")).toBeVisible();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.setViewportSize(size);
        await expect(page.getByTestId("parts-list")).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(
          saved,
        );
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(page.getByTestId("parts-list")).toBeVisible();
        await openWorkspaceAgent(page);
        await expect(page.getByTestId("parts-list")).toBeHidden();
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(page.getByTestId("parts-list")).toBeVisible();
        await page.keyboard.press("ControlOrMeta+b");
        await expect(page.getByTestId("parts-list")).toBeHidden();
        const folded = await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"));
        await openWorkspaceAgent(page);
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(page.getByTestId("parts-list")).toBeHidden();
        expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(
          folded,
        );
        await openWorkspaceAgent(page);
        await page.getByTestId("workspace-parts").click();
        await expect(page.getByTestId("parts-list")).toBeVisible();
        expect(
          await page.getByTestId("parts-list").evaluate((el) => el.getBoundingClientRect().width),
        ).toBeGreaterThan(200);
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(page.getByTestId("parts-list")).toBeHidden();
        expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(
          folded,
        );
        await openWorkspaceAgent(page);
        await page.getByTestId("workspace-parts").click();
        await expect(page.getByTestId("parts-list")).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId("parts-list")).toBeHidden();
        await page.setViewportSize(size);
        await expect(page.getByTestId("parts-list")).toBeHidden();
      }
      await openWorkspaceAgent(page);
      if (size.width === 390)
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
      await playFromCreate(page);
      if (size.width === 390) await page.getByTestId("menu-agent").click();
      await expect(page.locator(".play-bar")).toHaveCSS("border-bottom-width", "1px");
      await expect(page.locator(".play-strip")).toHaveCSS("border-top-width", "1px");
      if (size.width > 600)
        await expect
          .poll(async () => greenPicturePixels(await page.getByTestId("gpu-canvas").screenshot()))
          .toBeGreaterThan(1000);
      await page.screenshot({
        path: test.info().outputPath(`play-${size.width}-agent-open.png`),
        animations: "disabled",
      });
      const screen = page.locator(".screen");
      await expect(screen).toHaveClass(/tube/);
      if (size.width > 600) await expect(screen).toHaveClass(/remixing/);
      await expect(screen).toHaveCSS("box-shadow", "none");
      if (size.width === 390)
        await page
          .getByTestId("workspace-agent-panel")
          .getByRole("button", { name: "Close", exact: true })
          .click();
      if (size.width !== 1063) {
        await openWorkspaceAgent(page);
        await page.setViewportSize({ width: 1063, height: 815 });
        await expect(page.getByTestId("parts-list")).toBeHidden();
      }
    });
  }
});

/** The starter room's green scenery distinguishes a painted picture from a black first frame. */
function greenPicturePixels(bytes: Uint8Array): number {
  const { rgba } = decodePng(bytes);
  let count = 0;
  for (let at = 0; at < rgba.length; at += 4)
    if (
      rgba[at + 1]! > 60 &&
      rgba[at + 1]! > rgba[at]! * 1.5 &&
      rgba[at + 1]! > rgba[at + 2]! * 1.5
    )
      count++;
  return count;
}

/** Count the GPU's cyan keyboard rim in the outer edge, away from the room centre. */
function cyanEdgePixels(bytes: Uint8Array): number {
  const { width, height, rgba } = decodePng(bytes);
  let count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x > width * 0.1 && x < width * 0.9 && y > height * 0.12 && y < height * 0.88) continue;
      const at = (y * width + x) * 4;
      if (
        rgba[at + 1]! > 60 &&
        rgba[at + 2]! > 60 &&
        rgba[at + 1]! > rgba[at]! * 1.3 &&
        rgba[at + 2]! > rgba[at]! * 1.3
      )
        count++;
    }
  return count;
}

test("the bracket shortcut reopens temporary Parts without saving a fold @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await starter(page);
  const saved = await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"));
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("parts-list")).toBeHidden();
  const close = page
    .getByTestId("workspace-agent-panel")
    .getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await page.keyboard.press("[");
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(saved);
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await close.click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(saved);
});

test("Parts opened beside the Agent folds again when the Agent closes at another width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await starter(page);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("parts-list")).toBeHidden();
  await openWorkspaceAgent(page);
  await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByTestId("workspace-agent-panel")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("parts-list")).toBeHidden();
  await page.setViewportSize({ width: 1063, height: 815 });
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("parts-list")).toBeHidden();
});

test("Undo before naming a new room releases Parts when the Agent closes", async ({ page }) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await starter(page);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("parts-list")).toBeHidden();
  const saved = await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"));
  await openWorkspaceAgent(page);
  await page.getByTestId("workspace-parts").click();
  await page.getByRole("button", { name: "Add a room", exact: true }).click();
  await expect(page.getByTestId("room-rename-input")).toBeVisible();
  await page.getByTestId("workspace-undo").click();
  await expect(page.getByTestId("room-rename-input")).toBeHidden();
  await page
    .getByTestId("workspace-agent-panel")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("parts-list")).toBeHidden();
  await openWorkspaceAgent(page);
  await expect(page.getByTestId("parts-list")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.createDocks"))).toBe(saved);
});

/** Mount the shipped notice with a keyed replacement, as stage notices are replaced. */
async function notices(page: Page): Promise<void> {
  await page.goto("/");
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
  await page.evaluate(async () => {
    const path = "/e2e/fixtures/uxPolish.ts";
    const { mountNotices } = await import(path);
    mountNotices();
  });
  await expect(page.getByRole("status").filter({ hasText: "Notice" })).toBeVisible();
}

test("a notice replaced under a resting pointer stays for reading @webkit-desktop", async ({
  page,
}) => {
  await notices(page);
  const note = page.getByRole("status").filter({ hasText: "Notice" });
  await note.hover();
  // Replace through the keyboard without moving the pointer off the notice.
  await page.getByTestId("replace-notice").focus();
  await page.keyboard.press("Enter");
  await expect(note).toHaveText("Notice 2");
  await note.screenshot();
  await page.clock.runFor(2000);
  await expect(note).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(1001);
  await expect(note).toHaveCount(0);
});

test("focus and pointer each hold a notice until both leave @webkit-desktop", async ({ page }) => {
  await notices(page);
  const note = page.getByRole("status").filter({ hasText: "Notice" });
  const close = note.getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await note.hover();
  await page.clock.runFor(2000);
  await expect(note).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(2000);
  await expect(note).toBeVisible();
  await note.hover();
  await page.getByTestId("replace-notice").focus();
  await page.clock.runFor(2000);
  await expect(note).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(999);
  await expect(note).toBeVisible();
  await page.clock.runFor(2);
  await expect(note).toHaveCount(0);
});

for (const part of ["logic", "words", "inventory"]) {
  test(`${part} shows a calm note while its editor code loads`, async ({ page }) => {
    await page.setViewportSize({ width: 1063, height: 815 });
    await starter(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const file =
      part === "logic" ? "LogicEditor" : part === "words" ? "WordsEditor" : "TableEditor";
    await page.route(`**/src/studio/workspace/${file}.vue`, async (route) => {
      await pending;
      await route.continue();
    });
    const target = part === "logic" ? "part-room:1:logic" : `part-${part}`;
    await page.getByTestId(target).click();
    try {
      await expect(page.getByTestId("workspace-editor")).toContainText("Loading part…");
      for (const size of [
        { width: 1063, height: 815 },
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size);
        await page.screenshot({
          path: test.info().outputPath(`loading-${part}-${size.width}.png`),
        });
      }
    } finally {
      release();
    }
    await expect(page.getByTestId("workspace-editor")).not.toContainText("Loading part…");
  });
}

for (const part of ["logic:1", "words", "inventory"]) {
  test(`${part} keeps a loading note while the project session opens`, async ({ page }) => {
    await starter(page);
    await page.getByTestId("part-words").click();
    await page.evaluate((part) => {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith("monotio_agi.workspaceTabs."),
      )!;
      const tabs = JSON.stringify({ tabs: [part], selected: part });
      localStorage.setItem(key, tabs);
      sessionStorage.setItem(key, tabs);
    }, part);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/src\/project\/projectSession\.ts(\?.*)?$/, async (route) => {
      await pending;
      await route.continue();
    });
    await page.reload();
    try {
      await expect(page.getByTestId("workspace-editor")).toContainText("Loading part…");
      await expect(page.getByTestId("workspace-editor")).not.toContainText("Missing");
      await page.screenshot({
        path: test.info().outputPath(`session-loading-${part.replace(":", "-")}.png`),
      });
    } finally {
      release();
    }
    await expect(page.getByTestId("workspace-editor")).not.toContainText("Loading part…");
  });
}
