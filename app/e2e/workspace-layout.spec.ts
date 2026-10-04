import type { Locator, Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import {
  configureAi,
  isolateStorage,
  workspaceSaved,
  textHook,
  openGameOptions,
  waitForRoom,
  canvasColors,
} from "./engineProbe.ts";
import { openStoredWorkspace, openWorkspaceLogic } from "./workspaceShared.ts";

const sizes = [
  { width: 1063, height: 815 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await workspaceSaved(page);
  await waitForRoom(page, 1);
  await expect.poll(() => canvasColors(page)).toBeGreaterThan(1);
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}
async function originalShot(page: Page, name: string) {
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("toggle-original-aspect").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-container")).toHaveClass(/original-aspect/);
  await fit(page);
  await shot(page, `${name}-original`);
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("toggle-original-aspect").click();
  await page.keyboard.press("Escape");
}
async function inside(page: Page, locator: Locator) {
  expect.soft(await locator.isVisible()).toBe(true);
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect.soft(box).not.toBeNull();
  if (box) {
    expect.soft(box.x).toBeGreaterThanOrEqual(0);
    expect.soft(box.y).toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect.soft(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await locator.click({ trial: true });
  }
}
async function header(page: Page) {
  const overlaps = await page.locator(".play-bar").evaluate((bar) => {
    const controls = [...bar.querySelectorAll("button, [role=radio]")]
      .map((node) => ({
        name: node.textContent || node.getAttribute("aria-label"),
        box: node.getBoundingClientRect(),
      }))
      .filter(({ box }) => box.width > 0);
    return controls.flatMap((a, i) =>
      controls
        .slice(i + 1)
        .filter(
          (b) =>
            a.box.left < b.box.right &&
            b.box.left < a.box.right &&
            a.box.top < b.box.bottom &&
            b.box.top < a.box.bottom,
        )
        .map((b) => `${a.name} / ${b.name}`),
    );
  });
  expect.soft(overlaps).toEqual([]);
}
async function fit(page: Page) {
  const stage = page.locator(".stage:visible");
  await expect(stage).toBeVisible();
  await expect.soft
    .poll(async () =>
      stage.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const surface = [...node.querySelectorAll(".game-surface")].find(
          (el) => el.getBoundingClientRect().width > 0,
        )!;
        const rendered = surface.getBoundingClientRect();
        const ratio = rendered.width / rendered.height;
        return Math.abs(rendered.width - Math.floor(Math.min(box.width, box.height * ratio)));
      }),
    )
    .toBeLessThanOrEqual(1);
}
for (const size of sizes) {
  test.describe(`${size.width} workspace`, () => {
    test.use({ hasTouch: size.width === 390 });
    test(`workspace surfaces fit ${size.width}`, async ({ page }) => {
      await page.setViewportSize(size);
      await start(page);
      await page.getByRole("radio", { name: "Play", exact: true }).click();
      await shot(page, `play-${size.width}`);
      if (size.width > 600) {
        await fit(page);
        await originalShot(page, `play-${size.width}`);
      }
      await page.getByRole("radio", { name: "Create", exact: true }).click();
      await page.getByTestId("workspace-agent").click();
      await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
      await shot(page, `agent-${size.width}`);
      if (size.width === 390) {
        const box = (await page.locator(".game-surface:visible").boundingBox())!;
        expect.soft(box.width).toBe(358);
        expect.soft(box.x).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width).toBeLessThanOrEqual(size.width);
      }
      if (size.width > 600) {
        await fit(page);
        await expect.soft
          .poll(() =>
            page.locator(".shell-body").evaluate((body) => {
              const parts = body.querySelector(".parts-list")!.getBoundingClientRect();
              const agent = body.querySelector(".shell-side")!.getBoundingClientRect();
              const stage = body.querySelector(".stage")!.getBoundingClientRect();
              return Math.abs(
                stage.width - (body.getBoundingClientRect().width - parts.width - agent.width),
              );
            }),
          )
          .toBeLessThanOrEqual(1);
      }
      if (size.width > 600) await originalShot(page, `agent-${size.width}`);
      await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("agent-review")).toBeVisible();
      await page.getByTestId("agent-approve").click();
      await expect(page.getByTestId("agent-review")).toHaveCount(0);
      await expect(page.getByTestId("agent-review-outcome").last()).toHaveText("Approved");
      await page.getByTestId("agent-review-outcome").last().scrollIntoViewIfNeeded();
      await shot(page, `approved-${size.width}`);
      expect
        .soft(await page.getByTestId("agent-review-outcome").allTextContents())
        .toContain("Approved");
      await page.getByRole("button", { name: "Undo this", exact: true }).click();
      await page.getByTestId("agent-auto-approve").click();
      await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByRole("button", { name: "Undo this", exact: true })).toHaveCount(2);
      await expect(page.getByTestId("agent-review-outcome").last()).toHaveText(
        "Applied automatically",
      );
      await page.getByTestId("agent-review-outcome").last().scrollIntoViewIfNeeded();
      await shot(page, `automatic-${size.width}`);
      expect
        .soft(await page.getByTestId("agent-review-outcome").allTextContents())
        .toContain("Applied automatically");
      await page.getByTestId("agent-review-mode").click();
      await page.getByTestId("agent-message").fill("Add a welcome sign that answers look at sign");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("agent-review")).toBeVisible();
      await page.getByTestId("agent-reject").click();
      await expect(page.getByTestId("agent-review")).toHaveCount(0);
      await expect(page.getByTestId("agent-review-outcome").last()).toHaveText("Rejected");
      await page.getByTestId("agent-review-outcome").last().scrollIntoViewIfNeeded();
      await shot(page, `rejected-${size.width}`);
      expect
        .soft(await page.getByTestId("agent-review-outcome").allTextContents())
        .toContain("Rejected");
      await page.keyboard.press("ControlOrMeta+i");
      if (size.width === 390) {
        await page.getByTestId("workspace-parts").click();
        await page.getByTestId("part-room:1:logic").click();
        await expect(
          page.getByTestId("workspace-logic-editor").locator(".monaco-editor"),
        ).toBeVisible();
      } else await openWorkspaceLogic(page);
      if (
        size.width > 600 &&
        (await page.getByTestId("workspace-focus").getAttribute("aria-pressed")) === "true"
      )
        await page.getByTestId("workspace-focus").click();
      if (
        size.width === 390 &&
        (await page.getByTestId("workspace-focus").getAttribute("aria-pressed")) !== "true"
      )
        await page.getByTestId("workspace-focus").click();
      await shot(page, `editor-${size.width}`);
      if (size.width > 600) {
        await fit(page);
        await originalShot(page, `editor-${size.width}`);
        await page.getByTestId("workspace-agent").click();
        await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
        await fit(page);
        await shot(page, `editor-agent-${size.width}`);
      }
      expect((await textHook(page)).room).toBe(1);
    });
    for (const removed of [false, true]) {
      test(`read-only actions fit ${removed ? "removed" : "stale"} ${size.width}`, async ({
        page,
        context,
      }) => {
        await page.setViewportSize(size);
        await start(page);
        if (size.width === 390) await page.getByTestId("workspace-parts").click();
        await page.getByTestId("part-notes").click();
        if ((await page.getByTestId("workspace-focus").getAttribute("aria-pressed")) !== "true")
          await page.getByTestId("workspace-focus").click();
        await shot(page, `notes-${size.width}`);
        await expect.soft(page.getByTestId("project-tab-notes")).not.toContainText("Missing");
        const other = await context.newPage();
        await other.goto("/");
        if (removed)
          await other.evaluate(async () => {
            const storage = await import("/src/project/gameStorage.ts");
            await storage.clearCachedGame(storage.listCachedGames()[0]!.projectId);
          });
        else {
          await openStoredWorkspace(other, "My adventure");
          await other.getByTestId("part-notes").click();
          await other.getByLabel("Game notes", { exact: true }).fill("From the other tab");
          await workspaceSaved(other);
        }
        await page.bringToFront();
        const note = page.getByTestId(removed ? "removed-tab-note" : "stale-tab-note");
        await expect(note).toHaveCount(1);
        await expect(note.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(note).toHaveCount(1);
        if ((await page.getByTestId("workspace-focus").getAttribute("aria-pressed")) !== "true")
          await page.getByTestId("workspace-focus").click();
        await shot(page, `${removed ? "removed" : "stale"}-focus-${size.width}`);
        await header(page);
        for (const name of ["Download unsaved edits", "Download game", "Reload", "Exit"])
          await inside(page, note.getByRole("button", { name, exact: true, includeHidden: true }));
        for (const name of ["Download unsaved edits", "Download game"]) {
          const button = note.getByRole("button", { name, exact: true, includeHidden: true });
          const download = page.waitForEvent("download");
          await button.click();
          expect((await download).suggestedFilename()).toMatch(/\.zip$/);
        }
        if (size.width > 600) {
          await page.getByTestId("workspace-focus").click();
          await shot(page, `${removed ? "removed" : "stale"}-normal-${size.width}`);
          for (const name of ["Download unsaved edits", "Download game", "Reload", "Exit"])
            await inside(
              page,
              note.getByRole("button", { name, exact: true, includeHidden: true }),
            );
        }
        if (size.width === 390) {
          await page.getByTestId("workspace-agent").click();
          await expect(page.getByTestId("workspace-agent-panel")).toBeVisible();
          await shot(page, `${removed ? "removed" : "stale"}-agent-${size.width}`);
          for (const name of ["Download unsaved edits", "Download game", "Reload", "Exit"])
            await inside(page, note.getByRole("button", { name, exact: true }));
        }
        await note.getByRole("button", { name: "Exit", exact: true }).click();
        await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
      });
    }
  });
}

for (const size of sizes) {
  test.describe(`${size.width} workspace`, () => {
    test.use({ hasTouch: size.width === 390 });
    test(`Saving keeps the editor still and a refused save offers Download ${size.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await start(page);
      if (size.width === 390) await page.getByTestId("workspace-parts").click();
      await page.getByTestId("part-notes").click();
      const before = await page.getByLabel("Game notes", { exact: true }).boundingBox();
      await page.evaluate(() => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        session.submit = () =>
          new Promise((_, reject) =>
            Object.assign(window, { refuseSave: () => reject(new Error("Writes refused")) }),
          );
      });
      await page.getByLabel("Game notes", { exact: true }).fill("Current buffer");
      await expect(page.getByTestId("workspace-saved")).toContainText("Saving");
      await shot(page, `saving-${size.width}`);
      await expect.soft(page.getByTestId("download-unsaved-edits")).toHaveCount(0);
      expect
        .soft(await page.getByLabel("Game notes", { exact: true }).boundingBox())
        .toEqual(before);
      await expect
        .poll(() =>
          page.evaluate(() => typeof (window as unknown as { refuseSave?: () => void }).refuseSave),
        )
        .toBe("function");
      await page.evaluate(() => (window as unknown as { refuseSave(): void }).refuseSave());
      await expect(page.getByTestId("workspace-saved")).toContainText("Could not save");
      await expect(page.getByTestId("download-unsaved-edits")).toBeVisible();
      await shot(page, `refused-${size.width}`);
    });
  });
}

for (const size of [sizes[0]!, sizes[2]!, sizes[3]!]) {
  test(`entry and header boxes ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await isolateStorage(page);
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await shot(page, `home-${size.width}`);
    await page.getByTestId("shelf-template-custom").scrollIntoViewIfNeeded();
    await shot(page, `home-cards-${size.width}`);
    await page.getByTestId("create-adventure-toggle").click();
    const choices = page.getByRole("radiogroup", { name: "Starting point" });
    await expect(choices).toBeVisible();
    await shot(page, `new-game-${size.width}`);
    await expect.soft(choices.locator('[aria-checked="true"]')).toHaveCount(0);
    await expect.soft(page.getByTestId("local-create-submit")).toBeHidden();
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    await expect(page.getByTestId("input-line")).toBeEnabled();
    await workspaceSaved(page);
    await waitForRoom(page, 1);
    await shot(page, `header-${size.width}`);
    await header(page);
    if (size.width === 390) {
      const boxes = await page.locator(".play-bar button:visible").evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            name: node.getAttribute("aria-label"),
            y: Math.round(box.y + box.height / 2),
            right: box.right,
          };
        }),
      );
      const rows: number[] = [];
      for (const box of boxes) if (!rows.some((y) => Math.abs(y - box.y) <= 2)) rows.push(box.y);
      expect.soft(rows.length).toBeLessThanOrEqual(2);
      expect.soft(boxes.every((box) => box.right <= 390)).toBe(true);
      const settings = boxes.find((box) => box.name === "Settings")!;
      expect
        .soft(boxes.filter((box) => Math.abs(box.y - settings.y) <= 2).length)
        .toBeGreaterThan(1);
      await page.getByTestId("workspace-parts").click();
    }
    await shot(page, `parts-${size.width}`);
    await page.getByTestId("workspace-agent").click();
    const panel = page.getByTestId("workspace-agent-panel");
    await expect(panel).toBeVisible();
    for (let index = 0; index < 3; index++) {
      await page.getByTestId("agent-message").fill("Add a welcome sign");
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("agent-review")).toBeVisible();
      await page.getByTestId("agent-reject").click();
      await expect(page.getByTestId("agent-review")).toBeHidden();
    }
    await panel.locator(".agent-panel__feed").evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await shot(page, `agent-reading-${size.width}`);
  });
}
